using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using FamilienKochbuch.Api.Endpoints;
using FamilienKochbuch.Api.Jobs;
using FamilienKochbuch.Api.Tests.Infrastructure;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.Enums;
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

    // ── POST /api/recipes/import/url (P2-6 step 1) ──────────────────────

    /// <summary>
    /// Creates a fresh group owned by the given user (they become the
    /// admin via <see cref="PrivateCollectionService"/>-style seeding).
    /// Returns the new group id so the enqueue tests can post against
    /// a group the caller actually belongs to.
    /// </summary>
    private async Task<Guid> CreateOwnedGroupAsync(Guid userId, string name = "Familie")
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var now = DateTimeOffset.UtcNow;
        var group = new Group(name, null, now);
        var membership = new GroupMembership(userId, group.Id, GroupRole.Admin, now);
        db.Groups.Add(group);
        db.GroupMemberships.Add(membership);
        await db.SaveChangesAsync();
        return group.Id;
    }

    public sealed record UrlImportRequest(string Url, Guid GroupId);
    public sealed record ImportEnqueueResponse(Guid ImportId);

    [Fact]
    public async Task Url_Import_Anonymous_Gets_401()
    {
        var response = await _client.PostAsJsonAsync(
            "/api/recipes/import/url",
            new UrlImportRequest("https://example.com/rezept", Guid.NewGuid()));
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Url_Import_Happy_Path_Creates_Row_And_Enqueues_Job()
    {
        var (userId, token) = await SignupAsync("alice@ex.com", "Alice");
        var groupId = await CreateOwnedGroupAsync(userId);

        _factory.Jobs.Reset();

        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/recipes/import/url");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Content = JsonContent.Create(new UrlImportRequest(
            "https://example.com/rezept", groupId));

        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        var body = (await response.Content.ReadFromJsonAsync<ImportEnqueueResponse>())!;
        Assert.NotEqual(Guid.Empty, body.ImportId);

        // DB row is persisted in Queued state with the right source + URL.
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var import = await db.RecipeImports.AsNoTracking()
            .SingleAsync(i => i.Id == body.ImportId);
        Assert.Equal(userId, import.UserId);
        Assert.Equal(groupId, import.GroupId);
        Assert.Equal(ImportSource.Url, import.Source);
        Assert.Equal(ImportStatus.Queued, import.Status);
        Assert.Equal("https://example.com/rezept", import.SourceUrl);

        // The endpoint enqueued exactly one job, targeting the URL job's
        // ExecuteAsync(importId) overload.
        var captured = Assert.Single(_factory.Jobs.Created);
        Assert.Equal(typeof(ExtractRecipeFromUrlJob), captured.Job.Type);
        Assert.Equal(nameof(ExtractRecipeFromUrlJob.ExecuteAsync), captured.Job.Method.Name);
        Assert.Equal(body.ImportId, Assert.IsType<Guid>(captured.Job.Args[0]));
    }

    [Fact]
    public async Task Url_Import_Non_Member_Gets_403()
    {
        var (ownerId, _) = await SignupAsync("alice@ex.com", "Alice");
        var (_, intruderToken) = await SignupAsync("bob@ex.com", "Bob");
        var groupId = await CreateOwnedGroupAsync(ownerId);

        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/recipes/import/url");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", intruderToken);
        req.Content = JsonContent.Create(new UrlImportRequest(
            "https://example.com/rezept", groupId));

        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task Url_Import_Missing_Group_Gets_404()
    {
        var (_, token) = await SignupAsync("alice@ex.com", "Alice");

        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/recipes/import/url");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Content = JsonContent.Create(new UrlImportRequest(
            "https://example.com/rezept", Guid.NewGuid()));

        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("not-a-url")]
    [InlineData("ftp://example.com/x")]
    [InlineData("javascript:alert(1)")]
    [InlineData("/relative/only")]
    public async Task Url_Import_Rejects_Bad_Url(string url)
    {
        var (userId, token) = await SignupAsync("alice@ex.com", "Alice");
        var groupId = await CreateOwnedGroupAsync(userId);

        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/recipes/import/url");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Content = JsonContent.Create(new UrlImportRequest(url, groupId));

        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);

        // Nothing was created / enqueued.
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        Assert.False(await db.RecipeImports.AnyAsync());
    }

    // ── POST /api/recipes/import/photos (P2-6 step 2) ───────────────────

    public sealed record PhotoImportRequest(string[] PhotoUrls, Guid GroupId);

    /// <summary>
    /// Produces a well-formed signed photo URL the endpoint will accept
    /// as "owned" by the caller (signature check re-uses the existing
    /// <see cref="FamilienKochbuch.Api.Services.ImageSigningService"/>).
    /// </summary>
    private string SignPhotoUrl(string path)
    {
        using var scope = _factory.Services.CreateScope();
        var signer = scope.ServiceProvider
            .GetRequiredService<FamilienKochbuch.Api.Services.ImageSigningService>();
        return signer.SignUrl($"/api/photos/{path}", path);
    }

    [Fact]
    public async Task Photos_Import_Anonymous_Gets_401()
    {
        var response = await _client.PostAsJsonAsync(
            "/api/recipes/import/photos",
            new PhotoImportRequest(new[] { "/api/photos/a.png?sig=x&exp=1" }, Guid.NewGuid()));
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Photos_Import_Happy_Path_Creates_Row_And_Enqueues_Job()
    {
        var (userId, token) = await SignupAsync("alice@ex.com", "Alice");
        var groupId = await CreateOwnedGroupAsync(userId);

        _factory.Jobs.Reset();
        var photo1 = SignPhotoUrl("recipes/alice/1.jpg");
        var photo2 = SignPhotoUrl("recipes/alice/2.jpg");

        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/recipes/import/photos");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Content = JsonContent.Create(new PhotoImportRequest(
            new[] { photo1, photo2 }, groupId));

        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        var body = (await response.Content.ReadFromJsonAsync<ImportEnqueueResponse>())!;
        Assert.NotEqual(Guid.Empty, body.ImportId);

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var import = await db.RecipeImports.AsNoTracking()
            .SingleAsync(i => i.Id == body.ImportId);
        Assert.Equal(userId, import.UserId);
        Assert.Equal(groupId, import.GroupId);
        Assert.Equal(ImportSource.Photos, import.Source);
        Assert.Equal(ImportStatus.Queued, import.Status);
        // ResultJson is used as transit for the ordered photo URL list
        // (the Photos job reads it out before calling Python).
        Assert.NotNull(import.ResultJson);
        Assert.Contains("1.jpg", import.ResultJson);
        Assert.Contains("2.jpg", import.ResultJson);

        var captured = Assert.Single(_factory.Jobs.Created);
        Assert.Equal(typeof(ExtractRecipeFromPhotosJob), captured.Job.Type);
        Assert.Equal(nameof(ExtractRecipeFromPhotosJob.ExecuteAsync), captured.Job.Method.Name);
        Assert.Equal(body.ImportId, Assert.IsType<Guid>(captured.Job.Args[0]));
    }

    [Fact]
    public async Task Photos_Import_Non_Member_Gets_403()
    {
        var (ownerId, _) = await SignupAsync("alice@ex.com", "Alice");
        var (_, intruderToken) = await SignupAsync("bob@ex.com", "Bob");
        var groupId = await CreateOwnedGroupAsync(ownerId);

        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/recipes/import/photos");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", intruderToken);
        req.Content = JsonContent.Create(new PhotoImportRequest(
            new[] { SignPhotoUrl("recipes/bob/1.jpg") }, groupId));

        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task Photos_Import_Zero_Photos_Gets_400()
    {
        var (userId, token) = await SignupAsync("alice@ex.com", "Alice");
        var groupId = await CreateOwnedGroupAsync(userId);

        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/recipes/import/photos");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Content = JsonContent.Create(new PhotoImportRequest(Array.Empty<string>(), groupId));

        var response = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Photos_Import_Eleven_Photos_Gets_400()
    {
        var (userId, token) = await SignupAsync("alice@ex.com", "Alice");
        var groupId = await CreateOwnedGroupAsync(userId);

        var urls = Enumerable.Range(1, 11)
            .Select(i => SignPhotoUrl($"recipes/alice/{i}.jpg"))
            .ToArray();

        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/recipes/import/photos");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Content = JsonContent.Create(new PhotoImportRequest(urls, groupId));

        var response = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Photos_Import_Unsigned_Or_Tampered_Url_Gets_400()
    {
        var (userId, token) = await SignupAsync("alice@ex.com", "Alice");
        var groupId = await CreateOwnedGroupAsync(userId);

        // Unsigned: no sig/exp query.
        var bad = "/api/photos/recipes/alice/x.jpg";

        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/recipes/import/photos");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Content = JsonContent.Create(new PhotoImportRequest(new[] { bad }, groupId));

        var response = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }
}
