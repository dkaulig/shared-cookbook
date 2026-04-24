using System.Security.Claims;
using FamilienKochbuch.Api.Services;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Infrastructure.Persistence;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;

namespace FamilienKochbuch.Api.Endpoints;

/// <summary>
/// Self-service account endpoints for the currently-authenticated user:
/// change password, change display name. Admin-targets-other-user flows
/// live elsewhere (group-admin actions in GM1).
///
/// All endpoints <see cref="AuthorizationEndpointConventionBuilderExtensions.RequireAuthorization"/>
/// and operate strictly on the caller's own <see cref="User"/>. Error
/// payloads share the <see cref="ErrorResponse"/> envelope via
/// <see cref="FamilienResults"/>.
/// </summary>
public static class AccountEndpoints
{
    private const int DisplayNameMinLength = 2;
    private const int DisplayNameMaxLength = 50;

    public record ChangePasswordRequest(string CurrentPassword, string NewPassword, string NewPasswordConfirm);
    public record ChangeDisplayNameRequest(string DisplayName);

    public static void MapAccountEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/api/account").WithTags("Account");

        group.MapPost("/change-password", ChangePasswordAsync).RequireAuthorization();
        group.MapPatch("/display-name", ChangeDisplayNameAsync).RequireAuthorization();
    }

    private static async Task<IResult> ChangePasswordAsync(
        ChangePasswordRequest body,
        ClaimsPrincipal principal,
        UserManager<User> users,
        ILogger<AccountEndpointsLogCategory> logger)
    {
        if (!TryGetUserId(principal, out var userId))
            return Results.Unauthorized();

        if (string.IsNullOrEmpty(body.CurrentPassword)
            || string.IsNullOrEmpty(body.NewPassword)
            || string.IsNullOrEmpty(body.NewPasswordConfirm))
        {
            return FamilienResults.BadRequest(
                ErrorCodes.MissingFields,
                "Current password, new password, and confirmation are required.");
        }

        if (!string.Equals(body.NewPassword, body.NewPasswordConfirm, StringComparison.Ordinal))
        {
            return FamilienResults.BadRequest(
                ErrorCodes.PasswordMismatch,
                "New password and confirmation do not match.",
                fieldName: "newPasswordConfirm");
        }

        if (string.Equals(body.NewPassword, body.CurrentPassword, StringComparison.Ordinal))
        {
            return FamilienResults.BadRequest(
                ErrorCodes.PasswordUnchanged,
                "New password must differ from the current password.",
                fieldName: "newPassword");
        }

        var user = await users.FindByIdAsync(userId.ToString());
        if (user is null)
            return FamilienResults.Unauthorized(
                ErrorCodes.InvalidCredentials, "Current password is incorrect.");

        if (!await users.CheckPasswordAsync(user, body.CurrentPassword))
            return FamilienResults.Unauthorized(
                ErrorCodes.InvalidCredentials, "Current password is incorrect.");

        var result = await users.ChangePasswordAsync(user, body.CurrentPassword, body.NewPassword);
        if (!result.Succeeded)
        {
            logger.LogWarning(
                "ChangePasswordAsync failed for user {UserId}: {Errors}",
                user.Id,
                string.Join("; ", result.Errors.Select(e => $"{e.Code}: {e.Description}")));

            // Identity's Description strings are culture-localised and
            // sometimes include specifics the frontend renders better
            // on its own. Pin a fixed English developer message; the
            // frontend keys off the code for user-facing copy.
            return FamilienResults.BadRequest(
                ErrorCodes.PasswordRejected,
                "Password does not meet the policy.",
                fieldName: "newPassword");
        }

        // Side-effect policy (per plan): do NOT revoke the refresh token or
        // invalidate the access token — the user stays logged in on the
        // current device.
        return Results.NoContent();
    }

    private static async Task<IResult> ChangeDisplayNameAsync(
        ChangeDisplayNameRequest body,
        ClaimsPrincipal principal,
        AppDbContext db,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId))
            return Results.Unauthorized();

        var trimmed = body.DisplayName?.Trim() ?? string.Empty;
        if (trimmed.Length < DisplayNameMinLength || trimmed.Length > DisplayNameMaxLength)
        {
            return FamilienResults.BadRequest(
                ErrorCodes.DisplayNameInvalid,
                $"Display name must be between {DisplayNameMinLength} and {DisplayNameMaxLength} characters.",
                fieldName: "displayName");
        }

        var user = await db.Users.SingleOrDefaultAsync(u => u.Id == userId, ct);
        if (user is null)
            return Results.Unauthorized();

        try
        {
            user.SetDisplayName(trimmed);
        }
        catch (ArgumentException)
        {
            // Domain exception text may leak implementation detail —
            // emit a stable English message instead.
            return FamilienResults.BadRequest(
                ErrorCodes.DisplayNameInvalid,
                "Display name is invalid.",
                fieldName: "displayName");
        }

        await db.SaveChangesAsync(ct);

        return Results.Ok(new AuthEndpoints.AuthUserDto(
            user.Id,
            user.Email!,
            user.DisplayName,
            user.Role.ToString()));
    }

    // ── helpers ──────────────────────────────────────────────────────

    private static bool TryGetUserId(ClaimsPrincipal principal, out Guid userId)
    {
        userId = Guid.Empty;
        var sub = principal.FindFirstValue("sub")
                  ?? principal.FindFirstValue(ClaimTypes.NameIdentifier);
        return Guid.TryParse(sub, out userId);
    }

    /// <summary>Logger category marker — keeps <c>ILogger&lt;…&gt;</c> injection typed.</summary>
    private sealed class AccountEndpointsLogCategory;
}
