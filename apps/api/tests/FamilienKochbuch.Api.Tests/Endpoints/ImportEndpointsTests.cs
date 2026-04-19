using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using FamilienKochbuch.Api.Endpoints;
using FamilienKochbuch.Api.Tests.Infrastructure;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace FamilienKochbuch.Api.Tests.Endpoints;

/// <summary>
/// End-to-end tests for the P2-5 status endpoint
/// <c>GET /api/imports/{importId}</c>. Exercises owner / non-owner /
/// admin / anonymous auth paths against real JWT middleware.
/// </summary>
public class ImportEndpointsTests : IClassFixture<FamilienKochbuchWebApplicationFactory>, IAsyncLifetime
{
    private readonly FamilienKochbuchWebApplicationFactory _factory;
    private HttpClient _client = null!;

    public ImportEndpointsTests(FamilienKochbuchWebApplicationFactory factory)
    {
        _factory = factory;
    }

    public async Task InitializeAsync()
    {
        _client = _factory.CreateRateLimitBypassingClient(
            new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { HandleCookies = true });
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
        db.RecipeImports.RemoveRange(db.RecipeImports);
        db.RefreshTokens.RemoveRange(db.RefreshTokens);
        db.AppInvites.RemoveRange(db.AppInvites);
        var nonAdmin = db.Users.Where(u => u.Email != "admin@test.local");
        db.Users.RemoveRange(nonAdmin);
        await db.SaveChangesAsync();
    }

    private async Task<(Guid userId, string token)> SignupAsync(string email, string displayName)
    {
        var adminToken = (await LoginAsync("admin@test.local", "AdminPassword123!")).AccessToken;
        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/invites/app/");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", adminToken);
        req.Content = JsonContent.Create(new { });
        var inviteRes = await _client.SendAsync(req);
        inviteRes.EnsureSuccessStatusCode();
        var invite = await inviteRes.Content.ReadFromJsonAsync<InviteEndpoints.CreateInviteResponse>();

        using var fresh = _factory.CreateRateLimitBypassingClient(
            new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { HandleCookies = true });
        var signup = await fresh.PostAsJsonAsync(
            $"/api/auth/signup?token={invite!.Token}",
            new AuthEndpoints.SignupRequest(email, "Passwort123!", displayName));
        signup.EnsureSuccessStatusCode();
        var body = await signup.Content.ReadFromJsonAsync<AuthEndpoints.AuthResponse>();
        return (body!.User.Id, body.AccessToken);
    }

    private async Task<AuthEndpoints.AuthResponse> LoginAsync(string email, string password)
    {
        using var client = _factory.CreateRateLimitBypassingClient(
            new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { HandleCookies = true });
        var response = await client.PostAsJsonAsync("/api/auth/login",
            new AuthEndpoints.LoginRequest(email, password));
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadFromJsonAsync<AuthEndpoints.AuthResponse>())!;
    }

    private async Task<Guid> SeedImportAsync(Guid userId, Action<RecipeImport>? configure = null)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        // Create an arbitrary group owned by the user — the import
        // entity only needs a valid group FK; we don't exercise group
        // membership here.
        var group = new Group("ImportGroup", null, DateTimeOffset.UtcNow);
        db.Groups.Add(group);
        await db.SaveChangesAsync();

        var import = new RecipeImport(
            userId: userId,
            groupId: group.Id,
            source: ImportSource.Url,
            sourceUrl: "https://example.com/rezept",
            createdAt: DateTimeOffset.UtcNow);
        configure?.Invoke(import);
        db.RecipeImports.Add(import);
        await db.SaveChangesAsync();
        return import.Id;
    }

    [Fact]
    public async Task Anonymous_Gets_401()
    {
        var response = await _client.GetAsync($"/api/imports/{Guid.NewGuid()}");
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Owner_Gets_200_With_Status_Payload()
    {
        var (userId, token) = await SignupAsync("alice@ex.com", "Alice");
        var importId = await SeedImportAsync(userId);

        using var req = new HttpRequestMessage(HttpMethod.Get, $"/api/imports/{importId}");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<ImportEndpoints.ImportStatusResponse>();
        Assert.NotNull(body);
        Assert.Equal(importId, body!.Id);
        Assert.Equal("Queued", body.Status);
        Assert.Equal("Url", body.Source);
        Assert.Equal(0, body.Progress);
        Assert.Equal("https://example.com/rezept", body.SourceUrl);
        Assert.Null(body.Result);
        Assert.Null(body.Error);
    }

    [Fact]
    public async Task Owner_Running_State_Hides_Result_Until_Done()
    {
        var (userId, token) = await SignupAsync("alice@ex.com", "Alice");
        var importId = await SeedImportAsync(userId, import =>
        {
            // Seed an intermediate state — the endpoint should NOT
            // surface ResultJson while the job is still running.
            import.MarkRunning(50);
        });

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var row = db.RecipeImports.Single(i => i.Id == importId);
        row.GetType()
            .GetProperty(nameof(RecipeImport.ResultJson))!
            .SetValue(row, "[\"photo1\"]");
        await db.SaveChangesAsync();

        using var req = new HttpRequestMessage(HttpMethod.Get, $"/api/imports/{importId}");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var response = await _client.SendAsync(req);

        var body = (await response.Content.ReadFromJsonAsync<ImportEndpoints.ImportStatusResponse>())!;
        Assert.Equal("Running", body.Status);
        Assert.Null(body.Result);
    }

    [Fact]
    public async Task Owner_Done_State_Surfaces_Result()
    {
        var (userId, token) = await SignupAsync("alice@ex.com", "Alice");
        var importId = await SeedImportAsync(userId, import =>
        {
            import.MarkDone("{\"title\":\"Spätzle\"}", DateTimeOffset.UtcNow);
        });

        using var req = new HttpRequestMessage(HttpMethod.Get, $"/api/imports/{importId}");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var response = await _client.SendAsync(req);

        var body = (await response.Content.ReadFromJsonAsync<ImportEndpoints.ImportStatusResponse>())!;
        Assert.Equal("Done", body.Status);
        Assert.Equal("{\"title\":\"Spätzle\"}", body.Result);
        Assert.Equal(100, body.Progress);
    }

    [Fact]
    public async Task Other_User_Gets_403()
    {
        var (ownerId, _) = await SignupAsync("alice@ex.com", "Alice");
        var (_, intruderToken) = await SignupAsync("bob@ex.com", "Bob");
        var importId = await SeedImportAsync(ownerId);

        using var req = new HttpRequestMessage(HttpMethod.Get, $"/api/imports/{importId}");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", intruderToken);
        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task Admin_Can_Read_Other_Users_Imports()
    {
        var (ownerId, _) = await SignupAsync("alice@ex.com", "Alice");
        var importId = await SeedImportAsync(ownerId);
        var adminToken = (await LoginAsync("admin@test.local", "AdminPassword123!")).AccessToken;

        using var req = new HttpRequestMessage(HttpMethod.Get, $"/api/imports/{importId}");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", adminToken);
        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task Missing_Import_Returns_404()
    {
        var (_, token) = await SignupAsync("alice@ex.com", "Alice");

        using var req = new HttpRequestMessage(HttpMethod.Get, $"/api/imports/{Guid.NewGuid()}");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }
}
