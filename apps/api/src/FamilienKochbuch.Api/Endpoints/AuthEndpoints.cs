using System.Security.Claims;
using System.Security.Cryptography;
using FamilienKochbuch.Api.Services;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Infrastructure.Persistence;
using FamilienKochbuch.Infrastructure.Services;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
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
            return FamilienResults.BadRequest(
                ErrorCodes.InviteTokenMissing,
                "An invite token is required.",
                fieldName: "inviteToken");

        var now = clock.GetUtcNow();
        var invite = await db.AppInvites.SingleOrDefaultAsync(i => i.Token == token, ct);
        if (invite is null)
            return FamilienResults.BadRequest(
                ErrorCodes.InviteNotFound,
                "Invite not found.",
                fieldName: "inviteToken");
        if (!invite.IsValid(now))
            return FamilienResults.BadRequest(
                ErrorCodes.InviteInvalid,
                "Invite expired or already used.",
                fieldName: "inviteToken");

        if (string.IsNullOrWhiteSpace(body.Email) || string.IsNullOrWhiteSpace(body.Password) || string.IsNullOrWhiteSpace(body.DisplayName))
            return FamilienResults.BadRequest(
                ErrorCodes.MissingFields, "Email, password, and display name are required.");

        User user;
        try
        {
            user = new User();
            user.SetEmail(body.Email);
            user.SetDisplayName(body.DisplayName);
        }
        catch (ArgumentException)
        {
            // Do NOT echo the domain exception text — its message may
            // reference internal entity state. Keep the response generic
            // and rely on the code for branch logic.
            return FamilienResults.BadRequest(
                ErrorCodes.InvalidInput, "Invalid signup payload.");
        }
        user.EmailConfirmed = true; // invite flow pre-confirms

        if (await users.FindByEmailAsync(user.Email!) is not null)
            return FamilienResults.BadRequest(
                ErrorCodes.EmailTaken,
                "Email is already registered.",
                fieldName: "email");

        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var createResult = await users.CreateAsync(user, body.Password);
        if (!createResult.Succeeded)
        {
            // Identity error descriptions are culture-localised at the
            // framework level; don't forward them verbatim — use a
            // fixed English message and let the frontend render a
            // user-facing hint from the code.
            //
            // REL-4b — pin fieldName to "newPassword" so SignupPage can
            // focus the password input. The wire field is `password` but
            // we emit "newPassword" to match the canonical password-reject
            // vocabulary shared with ChangePassword / PasswordReset; the
            // frontend maps the hint to its actual input id.
            return FamilienResults.BadRequest(
                ErrorCodes.PasswordRejected,
                "Password does not meet the policy.",
                fieldName: "newPassword");
        }

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
            return FamilienResults.Unauthorized(
                ErrorCodes.InvalidCredentials, "Invalid email or password.");

        var user = await users.FindByEmailAsync(body.Email.Trim().ToLowerInvariant());
        if (user is null)
            return FamilienResults.Unauthorized(
                ErrorCodes.InvalidCredentials, "Invalid email or password.");

        // REL-0b — reject locked-out accounts BEFORE we verify the
        // password. AccessFailedAsync + Lockout options configured in
        // Program.cs lock after five wrong attempts for 15 minutes.
        // We keep the response identical to "wrong password" so the
        // endpoint doesn't leak lockout state to an attacker.
        if (await users.IsLockedOutAsync(user))
            return FamilienResults.Unauthorized(
                ErrorCodes.InvalidCredentials, "Invalid email or password.");

        if (!await users.CheckPasswordAsync(user, body.Password))
        {
            // Bumps AccessFailedCount + sets LockoutEnd once the
            // MaxFailedAccessAttempts threshold is crossed.
            await users.AccessFailedAsync(user);
            return FamilienResults.Unauthorized(
                ErrorCodes.InvalidCredentials, "Invalid email or password.");
        }

        // Correct password — reset the failure counter so transient
        // typos don't accumulate across successful logins.
        if (user.AccessFailedCount > 0)
            await users.ResetAccessFailedCountAsync(user);

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
        ILogger<User> logger,
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

                // Best-effort mail delivery — must NOT 5xx: a 500 here would
                // leak account existence to attackers (200 = no account, 500 =
                // account exists + SMTP broken). Endpoint stays uniformly 204.
                await EmailDeliveryHelper.TrySendAsync(
                    token => emailSender.SendPasswordResetAsync(user.Email, user.DisplayName, resetUrl, token),
                    logger,
                    $"password-reset:{user.Id}",
                    ct);
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
            return FamilienResults.BadRequest(
                ErrorCodes.InvalidInput, "Token and new password are required.");

        var parts = body.Token.Split('|', 2);
        if (parts.Length != 2 || !Guid.TryParse(parts[0], out var userId))
            return FamilienResults.BadRequest(
                ErrorCodes.InvalidToken,
                "Invalid reset link.",
                fieldName: "resetToken");

        var user = await users.FindByIdAsync(userId.ToString());
        if (user is null)
            return FamilienResults.BadRequest(
                ErrorCodes.InvalidToken,
                "Invalid reset link.",
                fieldName: "resetToken");

        var result = await users.ResetPasswordAsync(user, parts[1], body.NewPassword);
        if (!result.Succeeded)
        {
            // Same rationale as SignupAsync: don't forward Identity's
            // localized error descriptions — pin a stable English
            // message + rely on the code for branching.
            //
            // REL-4b — pin fieldName to "resetToken". Identity's failure
            // mode here lumps "bad token" and "password policy" together;
            // in practice an expired / already-consumed link is the most
            // common cause and the user's only recovery lever is to
            // request a new reset email, so the reset-token field is the
            // right focus target.
            return FamilienResults.BadRequest(
                ErrorCodes.ResetFailed,
                "Password reset failed. The link may be expired or the password rejected.",
                fieldName: "resetToken");
        }

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
