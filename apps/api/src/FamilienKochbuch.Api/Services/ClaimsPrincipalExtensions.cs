using System.Security.Claims;

namespace FamilienKochbuch.Api.Services;

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
}
