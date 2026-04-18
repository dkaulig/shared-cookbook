using System.Security.Claims;
using System.Security.Cryptography;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Infrastructure.Persistence;
using FamilienKochbuch.Infrastructure.Services;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace FamilienKochbuch.Api.Endpoints;

/// <summary>
/// Auth endpoints (signup via invite, login, refresh, logout, password
/// reset). Mirrors hoppr's <c>AuthEndpoints.MapAuthEndpoints</c> shape
/// but scoped strictly to S1.
/// </summary>
public static class AuthEndpoints
{
    private const string RefreshCookieName = "fk_refresh";

    public record SignupRequest(string Email, string Password, string DisplayName);
    public record LoginRequest(string Email, string Password);
    public record PasswordResetRequestBody(string Email);
    public record PasswordResetBody(string Token, string NewPassword);

    public record AuthUserDto(Guid Id, string Email, string DisplayName, string Role);
    public record AuthResponse(string AccessToken, AuthUserDto User);
    public record ErrorResponse(string Code, string Message);

    public static void MapAuthEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/api/auth").WithTags("Auth");

        group.MapPost("/signup", SignupAsync).AllowAnonymous();
        group.MapPost("/login", LoginAsync)
            .AllowAnonymous()
            .RequireRateLimiting(RateLimitPolicies.Login);
        group.MapPost("/refresh", RefreshAsync).AllowAnonymous();
        group.MapPost("/logout", LogoutAsync).RequireAuthorization();
        group.MapPost("/password-reset-request", PasswordResetRequestAsync).AllowAnonymous();
        group.MapPost("/password-reset", PasswordResetAsync).AllowAnonymous();
    }

    private static async Task<IResult> SignupAsync(
        SignupRequest body,
        string? token,
        HttpContext ctx,
        AppDbContext db,
        UserManager<User> users,
        TokenService tokens,
        IPrivateCollectionService privateCollections,
        TimeProvider clock,
        IOptions<JwtOptions> jwt,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(token))
            return Results.BadRequest(new ErrorResponse("invite_token_missing", "Ein Einladungstoken wird benötigt."));

        var now = clock.GetUtcNow();
        var invite = await db.AppInvites.SingleOrDefaultAsync(i => i.Token == token, ct);
        if (invite is null)
            return Results.BadRequest(new ErrorResponse("invite_not_found", "Einladung existiert nicht."));
        if (!invite.IsValid(now))
            return Results.BadRequest(new ErrorResponse("invite_invalid", "Einladung ist abgelaufen oder bereits verwendet."));

        if (string.IsNullOrWhiteSpace(body.Email) || string.IsNullOrWhiteSpace(body.Password) || string.IsNullOrWhiteSpace(body.DisplayName))
            return Results.BadRequest(new ErrorResponse("missing_fields", "E-Mail, Passwort und Anzeigename sind erforderlich."));

        User user;
        try
        {
            user = new User();
            user.SetEmail(body.Email);
            user.SetDisplayName(body.DisplayName);
        }
        catch (ArgumentException ex)
        {
            return Results.BadRequest(new ErrorResponse("invalid_input", ex.Message));
        }
        user.EmailConfirmed = true; // invite flow pre-confirms

        if (await users.FindByEmailAsync(user.Email!) is not null)
            return Results.BadRequest(new ErrorResponse("email_taken", "Diese E-Mail-Adresse ist bereits registriert."));

        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var createResult = await users.CreateAsync(user, body.Password);
        if (!createResult.Succeeded)
            return Results.BadRequest(new ErrorResponse(
                "password_rejected",
                string.Join("; ", createResult.Errors.Select(e => e.Description))));

        invite.MarkUsed(user.Id, now);
        await db.SaveChangesAsync(ct);
        await privateCollections.EnsurePrivateCollectionAsync(user.Id, ct);
        await tx.CommitAsync(ct);

        var access = tokens.CreateAccessToken(user);
        var refresh = await tokens.CreateRefreshTokenAsync(user, ct);
        SetRefreshCookie(ctx, refresh, jwt.Value, now);

        return Results.Ok(new AuthResponse(access.Token, ToDto(user)));
    }

    private static async Task<IResult> LoginAsync(
        LoginRequest body,
        HttpContext ctx,
        UserManager<User> users,
        TokenService tokens,
        TimeProvider clock,
        IOptions<JwtOptions> jwt,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(body.Email) || string.IsNullOrWhiteSpace(body.Password))
            return Results.Json(new ErrorResponse("invalid_credentials", "E-Mail oder Passwort ungültig."),
                statusCode: StatusCodes.Status401Unauthorized);

        var user = await users.FindByEmailAsync(body.Email.Trim().ToLowerInvariant());
        if (user is null || !await users.CheckPasswordAsync(user, body.Password))
            return Results.Json(new ErrorResponse("invalid_credentials", "E-Mail oder Passwort ungültig."),
                statusCode: StatusCodes.Status401Unauthorized);

        var now = clock.GetUtcNow();
        var access = tokens.CreateAccessToken(user);
        var refresh = await tokens.CreateRefreshTokenAsync(user, ct);
        SetRefreshCookie(ctx, refresh, jwt.Value, now);

        return Results.Ok(new AuthResponse(access.Token, ToDto(user)));
    }

    private static async Task<IResult> RefreshAsync(
        HttpContext ctx,
        AppDbContext db,
        UserManager<User> users,
        TokenService tokens,
        TimeProvider clock,
        IOptions<JwtOptions> jwt,
        CancellationToken ct)
    {
        if (!ctx.Request.Cookies.TryGetValue(RefreshCookieName, out var cookie) || string.IsNullOrEmpty(cookie))
            return Results.Unauthorized();

        var rotation = await tokens.RotateRefreshTokenAsync(cookie, ct);
        if (rotation is null)
        {
            // Reuse-detection already revoked the family; tell the client to re-auth.
            ClearRefreshCookie(ctx);
            return Results.Unauthorized();
        }

        var user = await users.FindByIdAsync(rotation.UserId.ToString())
                   ?? throw new InvalidOperationException("Refresh token references unknown user.");

        var access = tokens.CreateAccessToken(user);
        SetRefreshCookie(ctx, rotation.NewRawToken, jwt.Value, clock.GetUtcNow());
        return Results.Ok(new AuthResponse(access.Token, ToDto(user)));
    }

    private static async Task<IResult> LogoutAsync(
        HttpContext ctx,
        TokenService tokens,
        CancellationToken ct)
    {
        if (ctx.Request.Cookies.TryGetValue(RefreshCookieName, out var cookie) && !string.IsNullOrEmpty(cookie))
            await tokens.RevokeRefreshTokenAsync(cookie, ct);
        ClearRefreshCookie(ctx);
        return Results.NoContent();
    }

    private static async Task<IResult> PasswordResetRequestAsync(
        PasswordResetRequestBody body,
        UserManager<User> users,
        IEmailSender emailSender,
        IOptions<AppOptions> appOptions,
        CancellationToken ct)
    {
        if (!string.IsNullOrWhiteSpace(body.Email))
        {
            var user = await users.FindByEmailAsync(body.Email.Trim().ToLowerInvariant());
            if (user is not null && !string.IsNullOrEmpty(user.Email))
            {
                var resetToken = await users.GeneratePasswordResetTokenAsync(user);
                var composite = EncodeResetToken(user.Id, resetToken);
                var resetUrl =
                    $"{appOptions.Value.FrontendBaseUrl.TrimEnd('/')}/reset-password"
                    + $"?token={Uri.EscapeDataString(composite)}";
                await emailSender.SendPasswordResetAsync(user.Email, user.DisplayName, resetUrl, ct);
            }
        }
        // Always 204 — don't leak user existence.
        return Results.NoContent();
    }

    private static async Task<IResult> PasswordResetAsync(
        PasswordResetBody body,
        UserManager<User> users,
        TokenService tokens,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(body.Token) || string.IsNullOrWhiteSpace(body.NewPassword))
            return Results.BadRequest(new ErrorResponse("invalid_input", "Token und neues Passwort sind erforderlich."));

        var parts = body.Token.Split('|', 2);
        if (parts.Length != 2 || !Guid.TryParse(parts[0], out var userId))
            return Results.BadRequest(new ErrorResponse("invalid_token", "Ungültiger Reset-Link."));

        var user = await users.FindByIdAsync(userId.ToString());
        if (user is null)
            return Results.BadRequest(new ErrorResponse("invalid_token", "Ungültiger Reset-Link."));

        var result = await users.ResetPasswordAsync(user, parts[1], body.NewPassword);
        if (!result.Succeeded)
            return Results.BadRequest(new ErrorResponse(
                "reset_failed",
                string.Join("; ", result.Errors.Select(e => e.Description))));

        await tokens.RevokeAllForUserAsync(user.Id, ct);
        return Results.NoContent();
    }

    // ── helpers ──────────────────────────────────────────────────────
    private static AuthUserDto ToDto(User user) => new(user.Id, user.Email!, user.DisplayName, user.Role.ToString());

    private static void SetRefreshCookie(HttpContext ctx, string rawToken, JwtOptions jwt, DateTimeOffset now)
    {
        ctx.Response.Cookies.Append(RefreshCookieName, rawToken, new CookieOptions
        {
            HttpOnly = true,
            Secure = !string.Equals(ctx.Request.Scheme, "http", StringComparison.OrdinalIgnoreCase)
                     || ctx.Request.Host.Host != "localhost",
            SameSite = SameSiteMode.Lax,
            Path = "/api/auth",
            Expires = now.AddDays(jwt.RefreshTokenLifetimeDays),
        });
    }

    private static void ClearRefreshCookie(HttpContext ctx)
    {
        ctx.Response.Cookies.Delete(RefreshCookieName, new CookieOptions
        {
            HttpOnly = true,
            SameSite = SameSiteMode.Lax,
            Path = "/api/auth",
        });
    }

    /// <summary>
    /// Helper used by <c>PasswordResetRequest</c> to encode the ASP.NET Identity
    /// reset token together with the user id in one opaque URL param.
    /// </summary>
    internal static string EncodeResetToken(Guid userId, string resetToken) =>
        $"{userId}|{resetToken}";
}
