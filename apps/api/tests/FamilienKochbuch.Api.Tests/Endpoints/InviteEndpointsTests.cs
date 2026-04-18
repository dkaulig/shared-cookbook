using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using FamilienKochbuch.Api.Endpoints;
using FamilienKochbuch.Api.Tests.Infrastructure;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.Enums;
using FamilienKochbuch.Infrastructure.Persistence;
using FamilienKochbuch.Infrastructure.Services;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace FamilienKochbuch.Api.Tests.Endpoints;

/// <summary>
/// End-to-end tests for the /api/invites/app endpoints: create (auth),
/// preview (anon), delete (creator or admin only).
/// </summary>
public class InviteEndpointsTests : IClassFixture<FamilienKochbuchWebApplicationFactory>, IAsyncLifetime
{
    private readonly FamilienKochbuchWebApplicationFactory _factory;
    private HttpClient _client = null!;

    public InviteEndpointsTests(FamilienKochbuchWebApplicationFactory factory)
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
        db.AppInvites.RemoveRange(db.AppInvites);
        db.RefreshTokens.RemoveRange(db.RefreshTokens);
        db.Users.RemoveRange(db.Users.Where(u => u.Email != "admin@test.local"));
        await db.SaveChangesAsync();
    }

    private async Task<(HttpClient Client, User User)> CreateAuthenticatedClient(
        string email,
        UserRole role = UserRole.User)
    {
        using var scope = _factory.Services.CreateScope();
        var users = scope.ServiceProvider.GetRequiredService<UserManager<User>>();
        var user = new User { Role = role };
        user.SetEmail(email);
        user.SetDisplayName(email.Split('@')[0]);
        user.EmailConfirmed = true;
        var created = await users.CreateAsync(user, "Passwort123!");
        if (!created.Succeeded)
            throw new InvalidOperationException(string.Join(", ", created.Errors.Select(e => e.Description)));

        var client = _factory.CreateRateLimitBypassingClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions
        {
            HandleCookies = true,
        });
        var login = await client.PostAsJsonAsync("/api/auth/login",
            new AuthEndpoints.LoginRequest(email, "Passwort123!"));
        login.EnsureSuccessStatusCode();
        var body = await login.Content.ReadFromJsonAsync<AuthEndpoints.AuthResponse>();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", body!.AccessToken);
        return (client, user);
    }

    [Fact]
    public async Task Create_Invite_Requires_Authentication()
    {
        var anon = await _client.PostAsJsonAsync("/api/invites/app/", new InviteEndpoints.CreateInviteRequest());
        Assert.Equal(HttpStatusCode.Unauthorized, anon.StatusCode);
    }

    [Fact]
    public async Task Create_Invite_Returns_Token_And_Signup_Url()
    {
        var (client, _) = await CreateAuthenticatedClient("creator@example.com");

        var response = await client.PostAsJsonAsync("/api/invites/app/",
            new InviteEndpoints.CreateInviteRequest("recipient@example.com"));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<InviteEndpoints.CreateInviteResponse>();
        Assert.NotNull(body);
        Assert.Equal(AppInvite.TokenLength, body!.Token.Length);
        Assert.Contains(body.Token, body.InviteUrl);
        Assert.Contains("/signup?token=", body.InviteUrl);
    }

    [Fact]
    public async Task Preview_Returns_Inviter_DisplayName_And_Validity()
    {
        var (client, creator) = await CreateAuthenticatedClient("inviter@example.com");
        var createResponse = await client.PostAsJsonAsync("/api/invites/app/",
            new InviteEndpoints.CreateInviteRequest());
        var created = await createResponse.Content.ReadFromJsonAsync<InviteEndpoints.CreateInviteResponse>();

        var preview = await _client.GetAsync($"/api/invites/app/{created!.Token}");
        Assert.Equal(HttpStatusCode.OK, preview.StatusCode);
        var body = await preview.Content.ReadFromJsonAsync<InviteEndpoints.InvitePreviewResponse>();
        Assert.True(body!.Valid);
        Assert.Equal(creator.DisplayName, body.InviterDisplayName);
    }

    [Fact]
    public async Task Preview_Returns_404_For_Unknown_Token()
    {
        var response = await _client.GetAsync("/api/invites/app/definitely-not-a-real-token");
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task Delete_By_Creator_Succeeds()
    {
        var (client, _) = await CreateAuthenticatedClient("deleter@example.com");
        var created = await (await client.PostAsJsonAsync("/api/invites/app/", new InviteEndpoints.CreateInviteRequest()))
            .Content.ReadFromJsonAsync<InviteEndpoints.CreateInviteResponse>();

        var delete = await client.DeleteAsync($"/api/invites/app/{created!.Id}");
        Assert.Equal(HttpStatusCode.NoContent, delete.StatusCode);

        var preview = await _client.GetAsync($"/api/invites/app/{created.Token}");
        var body = await preview.Content.ReadFromJsonAsync<InviteEndpoints.InvitePreviewResponse>();
        Assert.False(body!.Valid);
    }

    [Fact]
    public async Task Delete_By_Non_Creator_Non_Admin_Returns_403()
    {
        var (creatorClient, _) = await CreateAuthenticatedClient("owner@example.com");
        var created = await (await creatorClient.PostAsJsonAsync("/api/invites/app/", new InviteEndpoints.CreateInviteRequest()))
            .Content.ReadFromJsonAsync<InviteEndpoints.CreateInviteResponse>();

        var (stranger, _) = await CreateAuthenticatedClient("stranger@example.com");
        var delete = await stranger.DeleteAsync($"/api/invites/app/{created!.Id}");
        Assert.Equal(HttpStatusCode.Forbidden, delete.StatusCode);
    }

    [Fact]
    public async Task Delete_By_Admin_Succeeds()
    {
        var (creatorClient, _) = await CreateAuthenticatedClient("owner2@example.com");
        var created = await (await creatorClient.PostAsJsonAsync("/api/invites/app/", new InviteEndpoints.CreateInviteRequest()))
            .Content.ReadFromJsonAsync<InviteEndpoints.CreateInviteResponse>();

        var (adminClient, _) = await CreateAuthenticatedClient("global.admin@example.com", UserRole.Admin);
        var delete = await adminClient.DeleteAsync($"/api/invites/app/{created!.Id}");
        Assert.Equal(HttpStatusCode.NoContent, delete.StatusCode);
    }

    [Fact]
    public async Task Used_Invite_Preview_Reports_Invalid()
    {
        var (client, _) = await CreateAuthenticatedClient("owner3@example.com");
        var created = await (await client.PostAsJsonAsync("/api/invites/app/", new InviteEndpoints.CreateInviteRequest()))
            .Content.ReadFromJsonAsync<InviteEndpoints.CreateInviteResponse>();

        // Burn the invite via signup.
        var signup = await _client.PostAsJsonAsync(
            $"/api/auth/signup?token={created!.Token}",
            new AuthEndpoints.SignupRequest("newbie@example.com", "Passwort123!", "Newbie"));
        signup.EnsureSuccessStatusCode();

        var preview = await _client.GetAsync($"/api/invites/app/{created.Token}");
        var body = await preview.Content.ReadFromJsonAsync<InviteEndpoints.InvitePreviewResponse>();
        Assert.False(body!.Valid);
    }
}
