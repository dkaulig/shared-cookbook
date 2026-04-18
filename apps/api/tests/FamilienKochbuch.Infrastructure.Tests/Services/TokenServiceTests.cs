using System.IdentityModel.Tokens.Jwt;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.Enums;
using FamilienKochbuch.Infrastructure.Persistence;
using FamilienKochbuch.Infrastructure.Services;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Time.Testing;
using Microsoft.IdentityModel.Tokens;
using Xunit;

namespace FamilienKochbuch.Infrastructure.Tests.Services;

/// <summary>
/// Exercises the issue + rotate + revoke flow of <see cref="TokenService"/>
/// against a real SQLite-in-memory EF context and a FakeTimeProvider so the
/// time-dependent assertions are deterministic.
/// </summary>
public class TokenServiceTests : IAsyncLifetime
{
    private SqliteConnection _connection = null!;
    private AppDbContext _db = null!;
    private FakeTimeProvider _clock = null!;
    private TokenService _service = null!;
    private User _user = null!;

    private static readonly JwtOptions Jwt = new()
    {
        SigningKey = "test-jwt-signing-key-that-is-definitely-long-enough-32chars!!",
        Issuer = "familien-kochbuch-test",
        Audience = "familien-kochbuch-web-test",
        AccessTokenLifetimeMinutes = 15,
        RefreshTokenLifetimeDays = 30,
    };

    public async Task InitializeAsync()
    {
        _connection = new SqliteConnection("DataSource=:memory:");
        await _connection.OpenAsync();

        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseSqlite(_connection)
            .Options;
        _db = new AppDbContext(options);
        await _db.Database.EnsureCreatedAsync();

        _clock = new FakeTimeProvider(startDateTime: new DateTimeOffset(2026, 4, 17, 12, 0, 0, TimeSpan.Zero));
        _service = new TokenService(_db, _clock, Options.Create(Jwt));

        _user = new User { Role = UserRole.User };
        _user.SetDisplayName("Test User");
        _user.SetEmail("user@example.com");
        _db.Users.Add(_user);
        await _db.SaveChangesAsync();
    }

    public async Task DisposeAsync()
    {
        await _db.DisposeAsync();
        await _connection.DisposeAsync();
    }

    private static TokenValidationParameters ValidationParams() => new()
    {
        ValidateIssuer = true,
        ValidIssuer = Jwt.Issuer,
        ValidateAudience = true,
        ValidAudience = Jwt.Audience,
        ValidateLifetime = false,
        ValidateIssuerSigningKey = true,
        IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(Jwt.SigningKey)),
        ClockSkew = TimeSpan.Zero,
    };

    [Fact]
    public void CreateAccessToken_Has_Expected_Claims_And_Expiry()
    {
        var result = _service.CreateAccessToken(_user);

        Assert.NotNull(result.Jti);
        Assert.Equal(_clock.GetUtcNow().AddMinutes(15), result.ExpiresAt);

        var principal = new JwtSecurityTokenHandler()
            .ValidateToken(result.Token, ValidationParams(), out var validated);
        var jwt = (JwtSecurityToken)validated;

        Assert.Equal(_user.Id.ToString(), principal.FindFirst("sub")?.Value);
        Assert.Equal("User", principal.FindFirst("role")?.Value);
        Assert.Equal(result.Jti, jwt.Id);
        Assert.Equal(Jwt.Issuer, jwt.Issuer);
        Assert.Contains(Jwt.Audience, jwt.Audiences);
    }

    [Fact]
    public async Task CreateRefreshToken_Persists_Hash_Only_And_Returns_Raw()
    {
        var raw = await _service.CreateRefreshTokenAsync(_user);

        Assert.False(string.IsNullOrWhiteSpace(raw));
        var stored = await _db.RefreshTokens.SingleAsync();
        // Stored hash must be SHA-256 of raw, NOT the raw token.
        var expectedHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(raw)));
        Assert.Equal(expectedHash, stored.TokenHash);
        Assert.Equal(_user.Id, stored.UserId);
        Assert.Equal(_clock.GetUtcNow().AddDays(30), stored.ExpiresAt);
    }

    [Fact]
    public async Task RotateRefreshToken_Marks_Old_Rotated_And_Issues_New()
    {
        var raw = await _service.CreateRefreshTokenAsync(_user);
        _clock.Advance(TimeSpan.FromMinutes(5));

        var result = await _service.RotateRefreshTokenAsync(raw);

        Assert.NotNull(result);
        Assert.NotEqual(raw, result!.NewRawToken);
        var tokens = await _db.RefreshTokens.OrderBy(t => t.IssuedAt).ToListAsync();
        Assert.Equal(2, tokens.Count);

        var old = tokens[0];
        var fresh = tokens[1];

        Assert.Equal(_clock.GetUtcNow(), old.RotatedAt);
        Assert.Equal(fresh.Id, old.ReplacedByTokenId);
        Assert.False(old.IsActive(_clock.GetUtcNow()));
        Assert.True(fresh.IsActive(_clock.GetUtcNow()));
    }

    [Fact]
    public async Task RotateRefreshToken_Returns_Null_For_Unknown_Raw_Token()
    {
        var result = await _service.RotateRefreshTokenAsync("not-a-valid-token");

        Assert.Null(result);
    }

    [Fact]
    public async Task RotateRefreshToken_Returns_Null_And_Revokes_Family_On_Reuse()
    {
        // Build a rotation chain: raw1 -> raw2 -> raw3. Then present raw1 again.
        var raw1 = await _service.CreateRefreshTokenAsync(_user);
        _clock.Advance(TimeSpan.FromMinutes(1));
        var rot1 = await _service.RotateRefreshTokenAsync(raw1);
        _clock.Advance(TimeSpan.FromMinutes(1));
        var rot2 = await _service.RotateRefreshTokenAsync(rot1!.NewRawToken);

        Assert.NotNull(rot2);
        var beforeReuseCount = await _db.RefreshTokens.CountAsync(t => t.RevokedAt == null);
        Assert.True(beforeReuseCount >= 1);

        // Replay the oldest — OWASP reuse-detection should revoke the whole chain.
        _clock.Advance(TimeSpan.FromMinutes(1));
        var reuseResult = await _service.RotateRefreshTokenAsync(raw1);

        Assert.Null(reuseResult);
        var activeAfter = await _db.RefreshTokens.CountAsync(t => t.RevokedAt == null);
        Assert.Equal(0, activeAfter);
    }

    [Fact]
    public async Task RevokeRefreshToken_Sets_RevokedAt_And_Returns_True_Once()
    {
        var raw = await _service.CreateRefreshTokenAsync(_user);
        _clock.Advance(TimeSpan.FromMinutes(1));

        var first = await _service.RevokeRefreshTokenAsync(raw);
        var second = await _service.RevokeRefreshTokenAsync(raw);

        Assert.True(first);
        Assert.False(second);
        var stored = await _db.RefreshTokens.SingleAsync();
        Assert.NotNull(stored.RevokedAt);
    }

    [Fact]
    public async Task RotateRefreshToken_Returns_Null_If_Expired()
    {
        var raw = await _service.CreateRefreshTokenAsync(_user);
        _clock.Advance(TimeSpan.FromDays(31));

        var result = await _service.RotateRefreshTokenAsync(raw);

        Assert.Null(result);
    }
}
