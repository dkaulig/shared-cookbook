using System.Security.Claims;

namespace SharedCookbook.Api.Services;

/// <summary>
/// Shared <see cref="ClaimsPrincipal"/> helpers. One place for the
/// admin-check so endpoints don't each re-implement the role claim
/// comparison.
/// </summary>
public static class ClaimsPrincipalExtensions
{
    /// <summary>
    /// Returns <c>true</c> when the caller is authenticated and carries
    /// the site-admin role claim. Mirrors the check
    /// <see cref="AdminOnlyAuthorizationFilter.IsAuthorized"/> runs for
    /// the Hangfire dashboard so both paths agree on the admin
    /// definition.
    /// </summary>
    public static bool IsAdmin(this ClaimsPrincipal? user)
    {
        if (user?.Identity is null || !user.Identity.IsAuthenticated)
            return false;
        return string.Equals(
            user.FindFirstValue(AdminOnlyAuthorizationFilter.RoleClaimType),
            AdminOnlyAuthorizationFilter.AdminRoleClaimValue,
            StringComparison.Ordinal);
    }

    /// <summary>
    /// Reads the caller's user-id off the <c>sub</c> / <c>nameid</c>
    /// claim. Returns <c>null</c> for anonymous principals or malformed
    /// claims — callers that strictly require a user (e.g. the admin-
    /// edit endpoints) pass the result into the entity's
    /// <c>UpdatedBy</c> slot, which accepts <c>null</c> to distinguish
    /// "system / seed" from "admin edit".
    /// </summary>
    public static Guid? GetUserId(this ClaimsPrincipal? user)
    {
        if (user?.Identity is null || !user.Identity.IsAuthenticated)
            return null;
        var sub = user.FindFirstValue("sub")
                  ?? user.FindFirstValue(ClaimTypes.NameIdentifier);
        return Guid.TryParse(sub, out var id) && id != Guid.Empty ? id : null;
    }
}
