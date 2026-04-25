using System.Net;
using System.Net.Http.Json;
using SharedCookbook.Api.Services;
using SharedCookbook.Api.Tests.Infrastructure;
using Xunit;

namespace SharedCookbook.Api.Tests.Endpoints;

/// <summary>
/// Cross-endpoint contract tests: every 4xx JSON response produced by
/// the API MUST use the uniform <see cref="ErrorResponse"/> envelope
/// (camelCase <c>code</c> + <c>message</c> fields). One representative
/// check per endpoint category; detailed behaviour lives in each
/// endpoint's dedicated test file.
/// </summary>
public class ErrorResponseContractTests : IClassFixture<SharedCookbookWebApplicationFactory>
{
    private readonly SharedCookbookWebApplicationFactory _factory;

    public ErrorResponseContractTests(SharedCookbookWebApplicationFactory factory)
    {
        _factory = factory;
    }

    [Fact]
    public async Task Auth_Signup_With_Missing_Token_Returns_ErrorResponse_Shape()
    {
        using var client = _factory.CreateRateLimitBypassingClient();
        var resp = await client.PostAsJsonAsync("/api/auth/signup",
            new { email = "x@y.z", password = "SomePass1!", displayName = "x" });

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<ErrorResponse>();
        Assert.NotNull(body);
        Assert.False(string.IsNullOrEmpty(body!.Code));
        Assert.False(string.IsNullOrEmpty(body.Message));
    }

    [Fact]
    public async Task Auth_Login_Invalid_Credentials_Returns_ErrorResponse_Shape_With_401()
    {
        using var client = _factory.CreateRateLimitBypassingClient();
        var resp = await client.PostAsJsonAsync("/api/auth/login",
            new { email = "", password = "" });

        Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<ErrorResponse>();
        Assert.NotNull(body);
        Assert.Equal("invalid_credentials", body!.Code);
    }

    [Fact]
    public async Task Invite_Preview_NotFound_Returns_ErrorResponse_Shape()
    {
        using var client = _factory.CreateRateLimitBypassingClient();
        var resp = await client.GetAsync("/api/invites/app/nonexistent-token");

        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<ErrorResponse>();
        Assert.NotNull(body);
        Assert.Equal("invite_not_found", body!.Code);
    }
}
