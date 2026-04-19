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

    // ── PV4: phase-tracking fields on GET /api/imports/{id} ─────────────
    //
    // These tests lock the wire contract after PV4: every new phase field
    // must round-trip through the endpoint so the frontend's polling
    // fallback (SignalR disconnected / tab-reloaded / new-tab deep-link)
    // gets the same authoritative snapshot the SignalR event would have
    // delivered. BUG-012 is resolved by the GroupId field specifically —
    // see the dedicated regression test below.

    [Fact]
    public async Task Owner_Fresh_Import_Exposes_Phase_Tracking_Defaults()
    {
        var (userId, token) = await SignupAsync("alice@ex.com", "Alice");
        var importId = await SeedImportAsync(userId);

        using var req = new HttpRequestMessage(HttpMethod.Get, $"/api/imports/{importId}");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = (await response.Content.ReadFromJsonAsync<ImportEndpoints.ImportStatusResponse>())!;

        // Fresh import: Phase=Queued (snake-case wire form), PhaseProgress=0,
        // AttemptNumber=1, ProgressLabel null until the first callback,
        // bytes/segments all null, LastProgressAt tracks CreatedAt at birth.
        Assert.Equal("queued", body.Phase);
        Assert.Equal(0, body.PhaseProgress);
        Assert.Equal(1, body.AttemptNumber);
        Assert.Null(body.ProgressLabel);
        Assert.Null(body.BytesDownloaded);
        Assert.Null(body.BytesTotal);
        Assert.Null(body.SegmentsDone);
        Assert.Null(body.SegmentsTotal);
        Assert.NotEqual(default, body.LastProgressAt);
    }

    [Fact]
    public async Task Owner_Status_Response_Carries_GroupId_For_Redirect()
    {
        // BUG-012 regression guard: the frontend auto-redirect to
        // /groups/{groupId}/recipes/new on Done hinges on groupId being
        // present in the status response. Previously omitted; PV4 adds it.
        Guid seededGroupId = Guid.Empty;
        var (userId, token) = await SignupAsync("alice@ex.com", "Alice");
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var group = new Group("GroupForRedirect", null, DateTimeOffset.UtcNow);
            db.Groups.Add(group);
            await db.SaveChangesAsync();
            seededGroupId = group.Id;

            var import = new RecipeImport(
                userId: userId,
                groupId: group.Id,
                source: ImportSource.Url,
                sourceUrl: "https://example.com/rezept",
                createdAt: DateTimeOffset.UtcNow);
            db.RecipeImports.Add(import);
            await db.SaveChangesAsync();

            using var req = new HttpRequestMessage(HttpMethod.Get, $"/api/imports/{import.Id}");
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            var response = await _client.SendAsync(req);

            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var body = (await response.Content.ReadFromJsonAsync<ImportEndpoints.ImportStatusResponse>())!;
            Assert.Equal(seededGroupId, body.GroupId);
        }
    }

    [Fact]
    public async Task Owner_Progress_Update_Surfaces_In_Response()
    {
        var (userId, token) = await SignupAsync("alice@ex.com", "Alice");
        var importId = await SeedImportAsync(userId, import =>
        {
            // Simulate a progress callback landing — phase advances, bytes
            // get filled in, ProgressLabel is auto-derived on the server.
            import.UpdateProgress(
                phase: RecipeImportPhase.Downloading,
                phaseProgress: 40,
                bytesDownloaded: 2_000_000L,
                bytesTotal: 5_000_000L,
                segmentsDone: null,
                segmentsTotal: null,
                attempt: 1,
                now: DateTimeOffset.UtcNow);
        });

        using var req = new HttpRequestMessage(HttpMethod.Get, $"/api/imports/{importId}");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var response = await _client.SendAsync(req);

        var body = (await response.Content.ReadFromJsonAsync<ImportEndpoints.ImportStatusResponse>())!;
        Assert.Equal("downloading", body.Phase);
        Assert.Equal(40, body.PhaseProgress);
        Assert.Equal(2_000_000L, body.BytesDownloaded);
        Assert.Equal(5_000_000L, body.BytesTotal);
        Assert.NotNull(body.ProgressLabel);
        Assert.Contains("heruntergeladen", body.ProgressLabel, StringComparison.OrdinalIgnoreCase);
        // Progress callback on a Queued row lifts Status→Running.
        Assert.Equal("Running", body.Status);
    }

    [Fact]
    public async Task Owner_Transcribing_Segments_Surface_In_Response()
    {
        var (userId, token) = await SignupAsync("alice@ex.com", "Alice");
        var importId = await SeedImportAsync(userId, import =>
        {
            import.UpdateProgress(
                phase: RecipeImportPhase.Transcribing,
                phaseProgress: 50,
                bytesDownloaded: null,
                bytesTotal: null,
                segmentsDone: 7,
                segmentsTotal: 14,
                attempt: 1,
                now: DateTimeOffset.UtcNow);
        });

        using var req = new HttpRequestMessage(HttpMethod.Get, $"/api/imports/{importId}");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var response = await _client.SendAsync(req);

        var body = (await response.Content.ReadFromJsonAsync<ImportEndpoints.ImportStatusResponse>())!;
        Assert.Equal("transcribing", body.Phase);
        Assert.Equal(50, body.PhaseProgress);
        Assert.Equal(7, body.SegmentsDone);
        Assert.Equal(14, body.SegmentsTotal);
        Assert.Null(body.BytesDownloaded);
        Assert.Null(body.BytesTotal);
    }

    [Fact]
    public async Task Owner_Retry_Bumps_AttemptNumber_In_Response()
    {
        var (userId, token) = await SignupAsync("alice@ex.com", "Alice");
        var importId = await SeedImportAsync(userId, import =>
        {
            import.StartAttempt(2, DateTimeOffset.UtcNow);
        });

        using var req = new HttpRequestMessage(HttpMethod.Get, $"/api/imports/{importId}");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var response = await _client.SendAsync(req);

        var body = (await response.Content.ReadFromJsonAsync<ImportEndpoints.ImportStatusResponse>())!;
        Assert.Equal(2, body.AttemptNumber);
        Assert.Equal("queued", body.Phase);
        Assert.Equal(0, body.PhaseProgress);
    }

    [Fact]
    public async Task Owner_LastProgressAt_Is_Iso_Timestamp_After_Update()
    {
        var updateAt = DateTimeOffset.Parse(
            "2026-04-19T12:34:56+00:00",
            System.Globalization.CultureInfo.InvariantCulture);
        var (userId, token) = await SignupAsync("alice@ex.com", "Alice");
        var importId = await SeedImportAsync(userId, import =>
        {
            import.UpdateProgress(
                phase: RecipeImportPhase.Structuring,
                phaseProgress: 10,
                bytesDownloaded: null,
                bytesTotal: null,
                segmentsDone: null,
                segmentsTotal: null,
                attempt: 1,
                now: updateAt);
        });

        using var req = new HttpRequestMessage(HttpMethod.Get, $"/api/imports/{importId}");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var response = await _client.SendAsync(req);

        var body = (await response.Content.ReadFromJsonAsync<ImportEndpoints.ImportStatusResponse>())!;
        Assert.Equal(updateAt, body.LastProgressAt);
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
    public async Task Photos_Import_Missing_Group_Gets_404()
    {
        var (_, token) = await SignupAsync("alice@ex.com", "Alice");
        var missingGroupId = Guid.NewGuid();

        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/recipes/import/photos");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Content = JsonContent.Create(new PhotoImportRequest(
            new[] { SignPhotoUrl("recipes/alice/1.jpg") }, missingGroupId));

        var response = await _client.SendAsync(req);

        // Parity with the URL-import 404 path (/api/recipes/import/url).
        // The photos endpoint must surface missing group the same way so
        // clients get a consistent error taxonomy.
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
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

    // ── GET /api/imports?mine=true (BUG-010 list) ────────────────────────

    /// <summary>
    /// Seeds a <see cref="RecipeImport"/> row owned by <paramref name="userId"/>
    /// inside <paramref name="groupId"/> at a specific creation timestamp.
    /// Lets the list-endpoint tests control ordering by time rather than
    /// depending on insertion order (EF doesn't guarantee that without
    /// an explicit sort).
    /// </summary>
    private async Task<Guid> SeedImportAtAsync(
        Guid userId,
        Guid groupId,
        DateTimeOffset createdAt,
        ImportSource source = ImportSource.Url,
        string? sourceUrl = "https://example.com/rezept")
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var import = new RecipeImport(
            userId: userId,
            groupId: groupId,
            source: source,
            sourceUrl: sourceUrl,
            createdAt: createdAt);
        db.RecipeImports.Add(import);
        await db.SaveChangesAsync();
        return import.Id;
    }

    [Fact]
    public async Task List_Mine_Anonymous_Gets_401()
    {
        var response = await _client.GetAsync("/api/imports?mine=true");
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task List_Mine_Returns_Callers_Imports_Newest_First()
    {
        var (userId, token) = await SignupAsync("alice@ex.com", "Alice");
        var groupId = await CreateOwnedGroupAsync(userId);

        var now = DateTimeOffset.UtcNow;
        var oldId = await SeedImportAtAsync(userId, groupId, now.AddMinutes(-30));
        var midId = await SeedImportAtAsync(userId, groupId, now.AddMinutes(-10));
        var newId = await SeedImportAtAsync(userId, groupId, now);

        using var req = new HttpRequestMessage(HttpMethod.Get, "/api/imports?mine=true");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<List<ImportEndpoints.ImportSummary>>();
        Assert.NotNull(body);
        Assert.Equal(3, body!.Count);
        Assert.Equal(newId, body[0].Id);
        Assert.Equal(midId, body[1].Id);
        Assert.Equal(oldId, body[2].Id);
    }

    [Fact]
    public async Task List_Mine_Excludes_Other_Users_Imports()
    {
        var (ownerId, _) = await SignupAsync("alice@ex.com", "Alice");
        var (callerId, callerToken) = await SignupAsync("bob@ex.com", "Bob");
        var ownerGroup = await CreateOwnedGroupAsync(ownerId, "OwnerGroup");
        var callerGroup = await CreateOwnedGroupAsync(callerId, "CallerGroup");

        var now = DateTimeOffset.UtcNow;
        await SeedImportAtAsync(ownerId, ownerGroup, now);
        var myImportId = await SeedImportAtAsync(callerId, callerGroup, now);

        using var req = new HttpRequestMessage(HttpMethod.Get, "/api/imports?mine=true");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", callerToken);
        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = (await response.Content.ReadFromJsonAsync<List<ImportEndpoints.ImportSummary>>())!;
        var single = Assert.Single(body);
        Assert.Equal(myImportId, single.Id);
    }

    [Fact]
    public async Task List_Mine_Skips_Imports_In_Groups_The_Caller_Left()
    {
        // Edge case: user enqueues an import, admin removes them from the
        // group. The import row stays in the database but should not
        // surface in the user's "my imports" list any more.
        var (userId, token) = await SignupAsync("alice@ex.com", "Alice");
        var groupId = await CreateOwnedGroupAsync(userId);

        var stillInGroup = await CreateOwnedGroupAsync(userId, "StillMember");
        await SeedImportAtAsync(userId, stillInGroup, DateTimeOffset.UtcNow);
        await SeedImportAtAsync(userId, groupId, DateTimeOffset.UtcNow);

        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var membership = await db.GroupMemberships
                .SingleAsync(m => m.GroupId == groupId && m.UserId == userId);
            db.GroupMemberships.Remove(membership);
            await db.SaveChangesAsync();
        }

        using var req = new HttpRequestMessage(HttpMethod.Get, "/api/imports?mine=true");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var response = await _client.SendAsync(req);

        var body = (await response.Content.ReadFromJsonAsync<List<ImportEndpoints.ImportSummary>>())!;
        var single = Assert.Single(body);
        Assert.Equal(stillInGroup, single.GroupId);
    }

    [Fact]
    public async Task List_Mine_Respects_Custom_Limit()
    {
        var (userId, token) = await SignupAsync("alice@ex.com", "Alice");
        var groupId = await CreateOwnedGroupAsync(userId);

        var now = DateTimeOffset.UtcNow;
        for (var i = 0; i < 5; i++)
        {
            await SeedImportAtAsync(userId, groupId, now.AddMinutes(-i));
        }

        using var req = new HttpRequestMessage(HttpMethod.Get, "/api/imports?mine=true&limit=2");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var response = await _client.SendAsync(req);

        var body = (await response.Content.ReadFromJsonAsync<List<ImportEndpoints.ImportSummary>>())!;
        Assert.Equal(2, body.Count);
    }

    [Fact]
    public async Task List_Mine_Clamps_Limit_Above_Hundred()
    {
        // Hostile limit values can't drain the table. The server silently
        // clamps above MaxMineImportsLimit rather than 400ing — the
        // frontend will never hit this branch but the guard must hold.
        var (userId, token) = await SignupAsync("alice@ex.com", "Alice");
        var groupId = await CreateOwnedGroupAsync(userId);

        var now = DateTimeOffset.UtcNow;
        for (var i = 0; i < 3; i++)
        {
            await SeedImportAtAsync(userId, groupId, now.AddMinutes(-i));
        }

        using var req = new HttpRequestMessage(HttpMethod.Get, "/api/imports?mine=true&limit=10000");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = (await response.Content.ReadFromJsonAsync<List<ImportEndpoints.ImportSummary>>())!;
        // All three rows surface — fewer than the cap, but the point is
        // the cap didn't error out.
        Assert.Equal(3, body.Count);
    }

    [Fact]
    public async Task List_Mine_Item_Exposes_Status_Phase_And_Progress_Label()
    {
        var (userId, token) = await SignupAsync("alice@ex.com", "Alice");
        var groupId = await CreateOwnedGroupAsync(userId);

        // Create an import and put it into a Running/Transcribing state
        // so the summary row covers every enum-mapped field.
        Guid importId;
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var import = new RecipeImport(
                userId: userId,
                groupId: groupId,
                source: ImportSource.Url,
                sourceUrl: "https://example.com/rezept",
                createdAt: DateTimeOffset.UtcNow);
            import.UpdateProgress(
                phase: RecipeImportPhase.Transcribing,
                phaseProgress: 50,
                bytesDownloaded: null,
                bytesTotal: null,
                segmentsDone: 5,
                segmentsTotal: 10,
                attempt: 1,
                now: DateTimeOffset.UtcNow);
            db.RecipeImports.Add(import);
            await db.SaveChangesAsync();
            importId = import.Id;
        }

        using var req = new HttpRequestMessage(HttpMethod.Get, "/api/imports?mine=true");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var response = await _client.SendAsync(req);

        var body = (await response.Content.ReadFromJsonAsync<List<ImportEndpoints.ImportSummary>>())!;
        var row = body.Single(r => r.Id == importId);
        Assert.Equal("Running", row.Status);
        Assert.Equal("Url", row.Source);
        Assert.Equal("transcribing", row.Phase);
        Assert.Equal("https://example.com/rezept", row.SourceUrl);
        Assert.NotNull(row.ProgressLabel);
        Assert.Null(row.CompletedAt);
        Assert.Null(row.Error);
    }

    [Fact]
    public async Task List_Mine_Mine_False_Gets_400()
    {
        // `mine=false` is a deliberate reject — admin list paths live
        // elsewhere; the public endpoint refuses to leak other users'
        // imports even to a hostile caller spamming the parameter.
        var (_, token) = await SignupAsync("alice@ex.com", "Alice");

        using var req = new HttpRequestMessage(HttpMethod.Get, "/api/imports?mine=false");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }
}
