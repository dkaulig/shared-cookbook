using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using FamilienKochbuch.Api.Endpoints;
using FamilienKochbuch.Api.Tests.Infrastructure;
using Xunit;

namespace FamilienKochbuch.Api.Tests.Endpoints;

/// <summary>
/// REL-4 — integration tests that pin the unified <c>ErrorResponse</c>
/// wire shape across representative 400 / 401 / 404 endpoints. These
/// complement <c>Services/ErrorCodesTests</c> (unit-level) with
/// end-to-end evidence that real endpoint output carries the same
/// envelope the helpers construct.
/// </summary>
public class ErrorResponseShapeTests : IClassFixture<FamilienKochbuchWebApplicationFactory>
{
    private readonly FamilienKochbuchWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public ErrorResponseShapeTests(FamilienKochbuchWebApplicationFactory factory)
    {
        _factory = factory;
        _client = factory.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions
        {
            AllowAutoRedirect = false,
        });
    }

    [Fact]
    public async Task Login_With_Blank_Credentials_Emits_Uniform_Envelope_With_Status_401()
    {
        var res = await _client.PostAsJsonAsync(
            "/api/auth/login",
            new AuthEndpoints.LoginRequest(string.Empty, string.Empty));

        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
        using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
        var root = doc.RootElement;
        Assert.Equal("invalid_credentials", root.GetProperty("code").GetString());
        Assert.False(string.IsNullOrWhiteSpace(root.GetProperty("message").GetString()));
        Assert.Equal(401, root.GetProperty("status").GetInt32());
        // 401 must NOT carry a fieldName — auth failure is not a field-
        // level validation.
        Assert.False(root.TryGetProperty("fieldName", out _));
    }

    [Fact]
    public async Task Signup_Missing_Token_Emits_400_With_Code_And_Status()
    {
        var res = await _client.PostAsJsonAsync(
            "/api/auth/signup",
            new AuthEndpoints.SignupRequest("a@b.de", "Passwort123!", "Foo"));

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
        var root = doc.RootElement;
        Assert.Equal("invite_token_missing", root.GetProperty("code").GetString());
        Assert.Equal(400, root.GetProperty("status").GetInt32());
    }

    [Fact]
    public async Task Preview_Unknown_Invite_Emits_404_With_Code_And_Status()
    {
        var res = await _client.GetAsync("/api/invites/app/does-not-exist");

        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
        using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
        var root = doc.RootElement;
        Assert.Equal("invite_not_found", root.GetProperty("code").GetString());
        Assert.Equal(404, root.GetProperty("status").GetInt32());
        // 404 must NOT carry a fieldName.
        Assert.False(root.TryGetProperty("fieldName", out _));
    }
}
