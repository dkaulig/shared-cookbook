using System.Security.Claims;
using Hangfire.Dashboard;

namespace FamilienKochbuch.Api.Services;

/// <summary>
/// Hangfire dashboard authorization filter — only principals whose JWT
/// "role" claim reads <c>Admin</c> (matching
/// <see cref="FamilienKochbuch.Domain.Enums.UserRole.Admin"/>) are
/// allowed through. Anonymous visitors + regular <c>User</c> principals
/// get a 401/403 from the dashboard pipeline.
///
/// The filter reads the current <see cref="HttpContext.User"/> so that
/// the standard JWT Bearer middleware (already wired on
/// <c>/api/*</c>) populates the identity before the dashboard
/// authorization runs. No extra auth hop inside Hangfire itself.
/// </summary>
public sealed class AdminOnlyAuthorizationFilter : IDashboardAuthorizationFilter
{
    /// <summary>The role-claim value that unlocks the dashboard. Kept
    /// as a constant so the test and the production wiring agree on
    /// the exact string.</summary>
    public const string AdminRoleClaimValue = "Admin";

    /// <summary>The claim type that carries the role name. Matches
    /// what <c>TokenService.CreateAccessToken</c> emits.</summary>
    public const string RoleClaimType = "role";

    public bool Authorize(DashboardContext context)
    {
        if (context is null) throw new ArgumentNullException(nameof(context));

        var httpContext = context.GetHttpContext();
        return IsAuthorized(httpContext.User);
    }

    /// <summary>
    /// Pure authorization check against a <see cref="ClaimsPrincipal"/>.
    /// Exposed <c>internal</c> so the unit tests (via
    /// <c>InternalsVisibleTo</c>) can exercise the decision without
    /// building a full <see cref="DashboardContext"/>.
    /// </summary>
    internal static bool IsAuthorized(ClaimsPrincipal? user)
    {
        if (user?.Identity is null || !user.Identity.IsAuthenticated)
            return false;

        return user.HasClaim(c =>
            c.Type == RoleClaimType &&
            string.Equals(c.Value, AdminRoleClaimValue, StringComparison.Ordinal));
    }
}
