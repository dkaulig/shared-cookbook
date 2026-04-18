using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using FamilienKochbuch.Api.Endpoints;
using FamilienKochbuch.Api.Tests.Infrastructure;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Infrastructure.Persistence;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace FamilienKochbuch.Api.Tests.Endpoints;

/// <summary>
/// End-to-end integration tests for the /api/account endpoints
/// introduced by AP1 (self-service password + display-name change).
/// </summary>
public class AccountEndpointsTests : IClassFixture<FamilienKochbuchWebApplicationFactory>, IAsyncLifetime
{
    private readonly FamilienKochbuchWebApplicationFactory _factory;
    private HttpClient _client = null!;

    public AccountEndpointsTests(FamilienKochbuchWebApplicationFactory factory)
    {
        _factory = factory;
    }

    public async Task InitializeAsync()
    {
        _client = _factory.CreateRateLimitBypassingClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions
        {
            HandleCookies = true,
        });
        await ResetAsync();
    }

    public Task DisposeAsync()
    {
        _client.Dispose();
        return Task.CompletedTask;
    }

    private async Task ResetAsync()
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        db.RefreshTokens.RemoveRange(db.RefreshTokens);
        db.Users.RemoveRange(db.Users.Where(u => u.Email != "admin@test.local"));
        await db.SaveChangesAsync();
    }

    private async Task<(HttpClient Client, User User)> CreateAuthenticatedClient(
        string email,
        string password = "Passwort123!")
    {
        using var scope = _factory.Services.CreateScope();
        var users = scope.ServiceProvider.GetRequiredService<UserManager<User>>();
        var user = new User();
        user.SetEmail(email);
        user.SetDisplayName(email.Split('@')[0]);
        user.EmailConfirmed = true;
        var created = await users.CreateAsync(user, password);
        if (!created.Succeeded)
            throw new InvalidOperationException(string.Join(", ", created.Errors.Select(e => e.Description)));

        var client = _factory.CreateRateLimitBypassingClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions
        {
            HandleCookies = true,
        });
        var login = await client.PostAsJsonAsync("/api/auth/login",
            new AuthEndpoints.LoginRequest(email, password));
        login.EnsureSuccessStatusCode();
        var body = await login.Content.ReadFromJsonAsync<AuthEndpoints.AuthResponse>();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", body!.AccessToken);
        return (client, user);
    }

    // ── CHANGE PASSWORD ─────────────────────────────────────────────

    [Fact]
    public async Task ChangePassword_Anonymous_Returns_401()
    {
        using var client = _factory.CreateRateLimitBypassingClient();
        var response = await client.PostAsJsonAsync(
            "/api/account/change-password",
            new AccountEndpoints.ChangePasswordRequest("Old123!!", "New123!!", "New123!!"));

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task ChangePassword_With_Correct_Current_Returns_204_And_New_Password_Works()
    {
        var (client, _) = await CreateAuthenticatedClient("pwok@example.com", "AltesPasswort1!");

        var response = await client.PostAsJsonAsync(
            "/api/account/change-password",
            new AccountEndpoints.ChangePasswordRequest("AltesPasswort1!", "NeuesPasswort1!", "NeuesPasswort1!"));

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);

        // Login with old password fails.
        using var probe = _factory.CreateRateLimitBypassingClient();
        var wrong = await probe.PostAsJsonAsync("/api/auth/login",
            new AuthEndpoints.LoginRequest("pwok@example.com", "AltesPasswort1!"));
        Assert.Equal(HttpStatusCode.Unauthorized, wrong.StatusCode);

        // Login with new password succeeds.
        var right = await probe.PostAsJsonAsync("/api/auth/login",
            new AuthEndpoints.LoginRequest("pwok@example.com", "NeuesPasswort1!"));
        Assert.Equal(HttpStatusCode.OK, right.StatusCode);
    }

    [Fact]
    public async Task ChangePassword_With_Wrong_Current_Returns_401()
    {
        var (client, _) = await CreateAuthenticatedClient("pwwrong@example.com", "AltesPasswort1!");

        var response = await client.PostAsJsonAsync(
            "/api/account/change-password",
            new AccountEndpoints.ChangePasswordRequest("FalschesAltesPasswort1!", "NeuesPasswort1!", "NeuesPasswort1!"));

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task ChangePassword_With_Mismatched_Confirm_Returns_400()
    {
        var (client, _) = await CreateAuthenticatedClient("pwmismatch@example.com", "AltesPasswort1!");

        var response = await client.PostAsJsonAsync(
            "/api/account/change-password",
            new AccountEndpoints.ChangePasswordRequest("AltesPasswort1!", "NeuesPasswort1!", "OtherPasswort1!"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<FamilienKochbuch.Api.Services.ErrorResponse>();
        Assert.Equal("password_mismatch", body!.Code);
    }

    [Fact]
    public async Task ChangePassword_When_New_Equals_Current_Returns_400()
    {
        var (client, _) = await CreateAuthenticatedClient("pwsame@example.com", "AltesPasswort1!");

        var response = await client.PostAsJsonAsync(
            "/api/account/change-password",
            new AccountEndpoints.ChangePasswordRequest("AltesPasswort1!", "AltesPasswort1!", "AltesPasswort1!"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<FamilienKochbuch.Api.Services.ErrorResponse>();
        Assert.Equal("password_unchanged", body!.Code);
    }

    [Fact]
    public async Task ChangePassword_With_Empty_Current_Returns_400()
    {
        var (client, _) = await CreateAuthenticatedClient("pwemptyc@example.com", "AltesPasswort1!");

        var response = await client.PostAsJsonAsync(
            "/api/account/change-password",
            new AccountEndpoints.ChangePasswordRequest("", "NeuesPasswort1!", "NeuesPasswort1!"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<FamilienKochbuch.Api.Services.ErrorResponse>();
        Assert.Equal("missing_fields", body!.Code);
    }

    [Fact]
    public async Task ChangePassword_With_Too_Short_New_Returns_400_With_Identity_Error()
    {
        var (client, _) = await CreateAuthenticatedClient("pwshort@example.com", "AltesPasswort1!");

        var response = await client.PostAsJsonAsync(
            "/api/account/change-password",
            new AccountEndpoints.ChangePasswordRequest("AltesPasswort1!", "short", "short"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<FamilienKochbuch.Api.Services.ErrorResponse>();
        Assert.Equal("password_rejected", body!.Code);
    }

    // ── CHANGE DISPLAYNAME ──────────────────────────────────────────

    [Fact]
    public async Task ChangeDisplayName_Anonymous_Returns_401()
    {
        using var client = _factory.CreateRateLimitBypassingClient();
        var request = new HttpRequestMessage(HttpMethod.Patch, "/api/account/display-name")
        {
            Content = JsonContent.Create(new AccountEndpoints.ChangeDisplayNameRequest("Neuer Name")),
        };
        var response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task ChangeDisplayName_Happy_Path_Returns_200_And_Persists_Trimmed_Value()
    {
        var (client, user) = await CreateAuthenticatedClient("dnok@example.com");

        var request = new HttpRequestMessage(HttpMethod.Patch, "/api/account/display-name")
        {
            Content = JsonContent.Create(new AccountEndpoints.ChangeDisplayNameRequest("  Neuer Name  ")),
        };
        var response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<AuthEndpoints.AuthUserDto>();
        Assert.NotNull(body);
        Assert.Equal("Neuer Name", body!.DisplayName);
        Assert.Equal(user.Id, body.Id);

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var reloaded = await db.Users.SingleAsync(u => u.Id == user.Id);
        Assert.Equal("Neuer Name", reloaded.DisplayName);
    }

    [Fact]
    public async Task ChangeDisplayName_With_Empty_String_Returns_400()
    {
        var (client, _) = await CreateAuthenticatedClient("dnempty@example.com");

        var request = new HttpRequestMessage(HttpMethod.Patch, "/api/account/display-name")
        {
            Content = JsonContent.Create(new AccountEndpoints.ChangeDisplayNameRequest("")),
        };
        var response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<FamilienKochbuch.Api.Services.ErrorResponse>();
        Assert.Equal("displayname_invalid", body!.Code);
    }

    [Fact]
    public async Task ChangeDisplayName_With_Whitespace_Only_Returns_400()
    {
        var (client, _) = await CreateAuthenticatedClient("dnwhite@example.com");

        var request = new HttpRequestMessage(HttpMethod.Patch, "/api/account/display-name")
        {
            Content = JsonContent.Create(new AccountEndpoints.ChangeDisplayNameRequest("   ")),
        };
        var response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<FamilienKochbuch.Api.Services.ErrorResponse>();
        Assert.Equal("displayname_invalid", body!.Code);
    }

    [Fact]
    public async Task ChangeDisplayName_With_One_Char_Returns_400()
    {
        var (client, _) = await CreateAuthenticatedClient("dnone@example.com");

        var request = new HttpRequestMessage(HttpMethod.Patch, "/api/account/display-name")
        {
            Content = JsonContent.Create(new AccountEndpoints.ChangeDisplayNameRequest("A")),
        };
        var response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<FamilienKochbuch.Api.Services.ErrorResponse>();
        Assert.Equal("displayname_invalid", body!.Code);
    }

    [Fact]
    public async Task ChangeDisplayName_With_51_Chars_Returns_400()
    {
        var (client, _) = await CreateAuthenticatedClient("dnlong@example.com");

        var fiftyOne = new string('a', 51);
        var request = new HttpRequestMessage(HttpMethod.Patch, "/api/account/display-name")
        {
            Content = JsonContent.Create(new AccountEndpoints.ChangeDisplayNameRequest(fiftyOne)),
        };
        var response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<FamilienKochbuch.Api.Services.ErrorResponse>();
        Assert.Equal("displayname_invalid", body!.Code);
    }

    [Fact]
    public async Task ChangeDisplayName_With_Exactly_50_Chars_Returns_200()
    {
        var (client, _) = await CreateAuthenticatedClient("dn50@example.com");

        var fifty = new string('a', 50);
        var request = new HttpRequestMessage(HttpMethod.Patch, "/api/account/display-name")
        {
            Content = JsonContent.Create(new AccountEndpoints.ChangeDisplayNameRequest(fifty)),
        };
        var response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<AuthEndpoints.AuthUserDto>();
        Assert.Equal(fifty, body!.DisplayName);
    }

    [Fact]
    public async Task ChangeDisplayName_With_Exactly_2_Chars_Returns_200()
    {
        var (client, _) = await CreateAuthenticatedClient("dn2@example.com");

        var request = new HttpRequestMessage(HttpMethod.Patch, "/api/account/display-name")
        {
            Content = JsonContent.Create(new AccountEndpoints.ChangeDisplayNameRequest("Al")),
        };
        var response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<AuthEndpoints.AuthUserDto>();
        Assert.Equal("Al", body!.DisplayName);
    }
}
