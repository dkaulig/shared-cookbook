using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;

namespace FamilienKochbuch.Infrastructure.Services;

/// <summary>
/// Issues JWT access tokens (HS256, 15 min) and refresh tokens (32 random
/// bytes, SHA-256-hashed for storage, 30 day lifetime). Rotation links
/// tokens via <c>ReplacedByTokenId</c>; presenting an already-rotated
/// token triggers OWASP reuse-detection and revokes the whole family.
/// </summary>
public class TokenService
{
    private const int RefreshTokenEntropyBytes = 32;

    private readonly AppDbContext _db;
    private readonly TimeProvider _clock;
    private readonly JwtOptions _options;
    private readonly ILogger<TokenService> _logger;

    public TokenService(
        AppDbContext db,
        TimeProvider clock,
        IOptions<JwtOptions> options,
        ILogger<TokenService>? logger = null)
    {
        _db = db;
        _clock = clock;
        _options = options.Value;
        _logger = logger ?? NullLogger<TokenService>.Instance;
    }

    public record AccessTokenResult(string Token, string Jti, DateTimeOffset ExpiresAt);

    public record RotationResult(string NewRawToken, DateTimeOffset ExpiresAt);

    public AccessTokenResult CreateAccessToken(User user)
    {
        var now = _clock.GetUtcNow();
        var expiresAt = now.AddMinutes(_options.AccessTokenLifetimeMinutes);
        var jti = Guid.NewGuid().ToString("N");

        var claims = new[]
        {
            new Claim(JwtRegisteredClaimNames.Sub, user.Id.ToString()),
            new Claim(JwtRegisteredClaimNames.Email, user.Email ?? string.Empty),
            new Claim(JwtRegisteredClaimNames.Jti, jti),
            new Claim("role", user.Role.ToString()),
            new Claim("displayName", user.DisplayName),
        };

        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(_options.SigningKey));
        var creds = new SigningCredentials(key, SecurityAlgorithms.HmacSha256);

        var jwt = new JwtSecurityToken(
            issuer: _options.Issuer,
            audience: _options.Audience,
            claims: claims,
            notBefore: now.UtcDateTime,
            expires: expiresAt.UtcDateTime,
            signingCredentials: creds);

        var handler = new JwtSecurityTokenHandler();
        handler.OutboundClaimTypeMap.Clear();

        return new AccessTokenResult(handler.WriteToken(jwt), jti, expiresAt);
    }

    public async Task<string> CreateRefreshTokenAsync(User user, CancellationToken ct = default)
    {
        var raw = GenerateRawToken();
        var now = _clock.GetUtcNow();

        var entity = new RefreshToken(
            userId: user.Id,
            tokenHash: HashToken(raw),
            issuedAt: now,
            expiresAt: now.AddDays(_options.RefreshTokenLifetimeDays));

        _db.RefreshTokens.Add(entity);
        await _db.SaveChangesAsync(ct);

        return raw;
    }

    /// <summary>
    /// Validates a presented refresh token and rotates it into a fresh one.
    /// Returns <c>null</c> when the token is unknown, expired, revoked, or
    /// already rotated (in which case the entire token family is revoked
    /// per OWASP refresh-token rotation guidance).
    /// </summary>
    public async Task<RotationResult?> RotateRefreshTokenAsync(string rawToken, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(rawToken))
            return null;

        var hash = HashToken(rawToken);
        var stored = await _db.RefreshTokens.SingleOrDefaultAsync(t => t.TokenHash == hash, ct);
        if (stored is null)
            return null;

        var now = _clock.GetUtcNow();

        // Reuse detection: presenting an already-rotated or revoked token is treated
        // as a stolen-credential signal. Kill the whole family.
        if (stored.RotatedAt is not null || stored.RevokedAt is not null)
        {
            _logger.LogWarning("Refresh token reuse detected for user {UserId} — revoking family.", stored.UserId);
            await RevokeUserTokenFamilyAsync(stored.UserId, now, ct);
            return null;
        }

        if (!stored.IsActive(now))
            return null;

        var newRaw = GenerateRawToken();
        var successor = new RefreshToken(
            userId: stored.UserId,
            tokenHash: HashToken(newRaw),
            issuedAt: now,
            expiresAt: now.AddDays(_options.RefreshTokenLifetimeDays));

        _db.RefreshTokens.Add(successor);
        stored.MarkRotated(now, successor.Id);

        await _db.SaveChangesAsync(ct);

        return new RotationResult(newRaw, successor.ExpiresAt);
    }

    /// <summary>Revokes the specific refresh token. Idempotent — returns false
    /// if the token is unknown or was already revoked/rotated.</summary>
    public async Task<bool> RevokeRefreshTokenAsync(string rawToken, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(rawToken))
            return false;

        var hash = HashToken(rawToken);
        var stored = await _db.RefreshTokens.SingleOrDefaultAsync(t => t.TokenHash == hash, ct);
        if (stored is null || stored.RevokedAt is not null)
            return false;

        stored.Revoke(_clock.GetUtcNow());
        await _db.SaveChangesAsync(ct);
        return true;
    }

    /// <summary>Revokes every active refresh token for a user (logout-all,
    /// password reset, reuse-detection).</summary>
    public async Task RevokeAllForUserAsync(Guid userId, CancellationToken ct = default)
    {
        await RevokeUserTokenFamilyAsync(userId, _clock.GetUtcNow(), ct);
    }

    private async Task RevokeUserTokenFamilyAsync(Guid userId, DateTimeOffset at, CancellationToken ct)
    {
        var active = await _db.RefreshTokens
            .Where(t => t.UserId == userId && t.RevokedAt == null)
            .ToListAsync(ct);

        foreach (var token in active)
            token.Revoke(at);

        await _db.SaveChangesAsync(ct);
    }

    private static string GenerateRawToken()
    {
        var bytes = RandomNumberGenerator.GetBytes(RefreshTokenEntropyBytes);
        return Convert.ToBase64String(bytes)
            .Replace('+', '-')
            .Replace('/', '_')
            .TrimEnd('=');
    }

    internal static string HashToken(string rawToken)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(rawToken));
        return Convert.ToHexString(bytes);
    }
}
