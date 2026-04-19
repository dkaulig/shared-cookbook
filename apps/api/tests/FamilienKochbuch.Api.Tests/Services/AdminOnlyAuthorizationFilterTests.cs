using System.Security.Claims;
using FamilienKochbuch.Api.Services;
using Xunit;

namespace FamilienKochbuch.Api.Tests.Services;

/// <summary>
/// Unit tests for <see cref="AdminOnlyAuthorizationFilter"/>. The
/// internal <c>IsAuthorized</c> static keeps the authorization
/// decision free of any Hangfire types, so we can exercise it with a
/// bare <see cref="ClaimsPrincipal"/>. The <c>Authorize</c> wrapper
/// just wires that through the dashboard context.
/// </summary>
public class AdminOnlyAuthorizationFilterTests
{
    [Fact]
    public void IsAuthorized_Returns_False_For_Anonymous()
    {
        Assert.False(AdminOnlyAuthorizationFilter.IsAuthorized(
            new ClaimsPrincipal(new ClaimsIdentity())));
    }

    [Fact]
    public void IsAuthorized_Returns_False_For_Authenticated_Member()
    {
        var identity = new ClaimsIdentity(
            new[]
            {
                new Claim(ClaimTypes.NameIdentifier, Guid.NewGuid().ToString()),
                new Claim(AdminOnlyAuthorizationFilter.RoleClaimType, "User"),
            },
            authenticationType: "Test");

        Assert.False(AdminOnlyAuthorizationFilter.IsAuthorized(
            new ClaimsPrincipal(identity)));
    }

    [Fact]
    public void IsAuthorized_Returns_True_For_Admin()
    {
        var identity = new ClaimsIdentity(
            new[]
            {
                new Claim(ClaimTypes.NameIdentifier, Guid.NewGuid().ToString()),
                new Claim(AdminOnlyAuthorizationFilter.RoleClaimType,
                    AdminOnlyAuthorizationFilter.AdminRoleClaimValue),
            },
            authenticationType: "Test");

        Assert.True(AdminOnlyAuthorizationFilter.IsAuthorized(
            new ClaimsPrincipal(identity)));
    }

    [Fact]
    public void IsAuthorized_Is_Case_Sensitive_On_Role_Value()
    {
        // The TokenService emits "Admin" exactly; "admin"/"ADMIN" must
        // NOT slip through.
        var identity = new ClaimsIdentity(
            new[] { new Claim(AdminOnlyAuthorizationFilter.RoleClaimType, "admin") },
            authenticationType: "Test");

        Assert.False(AdminOnlyAuthorizationFilter.IsAuthorized(
            new ClaimsPrincipal(identity)));
    }

    [Fact]
    public void IsAuthorized_Returns_False_For_Null_Principal()
    {
        Assert.False(AdminOnlyAuthorizationFilter.IsAuthorized(null));
    }

    [Fact]
    public void IsAuthorized_Ignores_Unrelated_Role_Claim_Types()
    {
        // ClaimTypes.Role (the default Identity role claim) is NOT what
        // TokenService emits — the code only trusts the short "role"
        // claim type it mints itself.
        var identity = new ClaimsIdentity(
            new[] { new Claim(ClaimTypes.Role, "Admin") },
            authenticationType: "Test");

        Assert.False(AdminOnlyAuthorizationFilter.IsAuthorized(
            new ClaimsPrincipal(identity)));
    }
}
