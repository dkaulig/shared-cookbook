using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using FamilienKochbuch.Api.Endpoints;
using FamilienKochbuch.Api.Hubs;
using FamilienKochbuch.Api.Services;
using FamilienKochbuch.Api.Tests.Infrastructure;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.Enums;
using FamilienKochbuch.Infrastructure.Persistence;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace FamilienKochbuch.Api.Tests.Endpoints;

/// <summary>
/// PV1 — end-to-end tests for <c>POST /api/internal/imports/{id}/progress</c>,
/// the Python extractor's progress callback. Covers auth (HMAC token),
/// 404 on unknown import, 422 on body validation, 429 on rate-limit
/// burst, and the publisher fan-out on accept.
///
/// The <see cref="InternalOnlyMiddleware"/> is exercised by a dedicated
/// <see cref="InternalOnlyMiddlewareTests"/> class — tests in this
/// class bypass the middleware via the <c>X-Test-Internal-Allow</c>
/// header so the endpoint's own behaviour is observable.
/// </summary>
public class InternalImportProgressEndpointTests
    : IClassFixture<FamilienKochbuchWebApplicationFactory>, IAsyncLifetime
{
    private readonly FamilienKochbuchWebApplicationFactory _factory;
    private HttpClient _client = null!;
    private Guid _userId;
    private Guid _groupId;

    public InternalImportProgressEndpointTests(FamilienKochbuchWebApplicationFactory factory)
    {
        _factory = factory;
    }

    public async Task InitializeAsync()
    {
        _client = _factory.CreateRateLimitBypassingClient();
        _client.DefaultRequestHeaders.Add(InternalOnlyMiddleware.TestBypassHeader, "true");
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
        var nonAdmin = db.Users.Where(u => u.Email != "admin@test.local");
        db.Users.RemoveRange(nonAdmin);
        await db.SaveChangesAsync();

        var user = new User { Role = UserRole.User };
        user.SetDisplayName("Owner");
        user.SetEmail($"owner-{Guid.NewGuid():N}@test.local");
        var group = new Group("G", null, DateTimeOffset.UtcNow);
        db.Users.Add(user);
        db.Groups.Add(group);
        await db.SaveChangesAsync();
        _userId = user.Id;
        _groupId = group.Id;
    }

    private async Task<Guid> SeedImportAsync()
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var import = new RecipeImport(
            userId: _userId, groupId: _groupId,
            source: ImportSource.Url,
            sourceUrl: "https://example.com/x",
            createdAt: _factory.Clock.GetUtcNow());
        db.RecipeImports.Add(import);
        await db.SaveChangesAsync();
        return import.Id;
    }

    private string SignToken(Guid importId, TimeSpan? lifetime = null)
    {
        var tokens = _factory.Services.GetRequiredService<ImportProgressTokenService>();
        var ttl = lifetime ?? TimeSpan.FromMinutes(5);
        return tokens.Sign(importId, _factory.Clock.GetUtcNow().Add(ttl));
    }

    private static HttpRequestMessage BuildRequest(
        Guid importId, string token, object body)
    {
        var req = new HttpRequestMessage(
            HttpMethod.Post,
            $"/api/internal/imports/{importId}/progress");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Content = JsonContent.Create(body);
        return req;
    }

    [Fact]
    public async Task Valid_Token_Happy_Path_Returns_204_And_Persists_Update()
    {
        var importId = await SeedImportAsync();
        var body = new
        {
            phase = "downloading",
            phase_progress = 30,
            bytes_done = 3_000_000L,
            bytes_total = 10_000_000L,
            attempt = 1,
        };

        var res = await _client.SendAsync(
            BuildRequest(importId, SignToken(importId), body));

        Assert.Equal(HttpStatusCode.NoContent, res.StatusCode);

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var import = await db.RecipeImports.FindAsync(importId);
        Assert.NotNull(import);
        Assert.Equal(RecipeImportPhase.Downloading, import!.Phase);
        Assert.Equal(30, import.PhaseProgress);
        Assert.Equal(3_000_000L, import.BytesDownloaded);
        Assert.Equal(10_000_000L, import.BytesTotal);
        // Weighted formula: Downloading 0-15 starts at 5, range 10 → 30% = 8.
        Assert.Equal(8, import.Progress);
    }

    [Fact]
    public async Task Missing_Authorization_Header_Returns_401()
    {
        var importId = await SeedImportAsync();
        var req = new HttpRequestMessage(
            HttpMethod.Post, $"/api/internal/imports/{importId}/progress");
        req.Content = JsonContent.Create(new { phase = "downloading", phase_progress = 10, attempt = 1 });
        var res = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
    }

    [Fact]
    public async Task Bad_Token_Returns_401()
    {
        var importId = await SeedImportAsync();
        var res = await _client.SendAsync(
            BuildRequest(importId, "not.a.real.token", new { phase = "downloading", phase_progress = 10, attempt = 1 }));
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
    }

    [Fact]
    public async Task Cross_Import_Token_Returns_401()
    {
        var importId = await SeedImportAsync();
        var otherImportId = Guid.NewGuid();
        var crossToken = SignToken(otherImportId);

        var res = await _client.SendAsync(
            BuildRequest(importId, crossToken, new { phase = "downloading", phase_progress = 10, attempt = 1 }));

        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
    }

    [Fact]
    public async Task Unknown_Import_Returns_404()
    {
        var unknownId = Guid.NewGuid();
        var token = SignToken(unknownId);
        var res = await _client.SendAsync(
            BuildRequest(unknownId, token, new { phase = "downloading", phase_progress = 10, attempt = 1 }));
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }

    [Fact]
    public async Task Invalid_Phase_Returns_422()
    {
        var importId = await SeedImportAsync();
        var token = SignToken(importId);
        var res = await _client.SendAsync(BuildRequest(
            importId, token,
            new { phase = "nonsense", phase_progress = 10, attempt = 1 }));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, res.StatusCode);
    }

    [Fact]
    public async Task Out_Of_Range_PhaseProgress_Returns_422()
    {
        var importId = await SeedImportAsync();
        var token = SignToken(importId);
        var res = await _client.SendAsync(BuildRequest(
            importId, token,
            new { phase = "downloading", phase_progress = 150, attempt = 1 }));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, res.StatusCode);
    }

    [Fact]
    public async Task Zero_Attempt_Returns_422()
    {
        var importId = await SeedImportAsync();
        var token = SignToken(importId);
        var res = await _client.SendAsync(BuildRequest(
            importId, token,
            new { phase = "downloading", phase_progress = 10, attempt = 0 }));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, res.StatusCode);
    }

    [Fact]
    public async Task Out_Of_Order_Update_Still_Returns_204_Idempotent()
    {
        // First accept transcribing 50%...
        var importId = await SeedImportAsync();
        var token = SignToken(importId);
        await _client.SendAsync(BuildRequest(importId, token,
            new { phase = "transcribing", phase_progress = 50, attempt = 1 }));

        // Then a late "downloading 10%" from the previous phase should
        // be silently discarded by the domain guard — but the endpoint
        // still returns 204 (idempotent).
        var res = await _client.SendAsync(BuildRequest(importId, token,
            new { phase = "downloading", phase_progress = 10, attempt = 1 }));

        Assert.Equal(HttpStatusCode.NoContent, res.StatusCode);

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var import = await db.RecipeImports.FindAsync(importId);
        Assert.Equal(RecipeImportPhase.Transcribing, import!.Phase);
        Assert.Equal(50, import.PhaseProgress);
    }

    [Fact]
    public async Task Publishes_SignalR_Event_On_Accept()
    {
        // Replace the DI publisher with a recording one for this scope.
        var recorder = new RecordingImportProgressPublisher();
        using var factory = new FamilienKochbuchWebApplicationFactory();
        factory.WithPublisher(recorder);
        await ((IAsyncLifetime)factory).InitializeAsync();
        using var client = factory.CreateRateLimitBypassingClient();
        client.DefaultRequestHeaders.Add(InternalOnlyMiddleware.TestBypassHeader, "true");

        Guid importId;
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var user = new User { Role = UserRole.User };
            user.SetDisplayName("Owner");
            user.SetEmail($"u-{Guid.NewGuid():N}@t.local");
            var group = new Group("G", null, DateTimeOffset.UtcNow);
            db.Users.Add(user); db.Groups.Add(group);
            await db.SaveChangesAsync();

            var import = new RecipeImport(user.Id, group.Id, ImportSource.Url,
                "https://x", factory.Clock.GetUtcNow());
            db.RecipeImports.Add(import);
            await db.SaveChangesAsync();
            importId = import.Id;
        }
        var tokens = factory.Services.GetRequiredService<ImportProgressTokenService>();
        var token = tokens.Sign(importId, factory.Clock.GetUtcNow().AddMinutes(5));

        var req = new HttpRequestMessage(
            HttpMethod.Post, $"/api/internal/imports/{importId}/progress");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Content = JsonContent.Create(new { phase = "transcribing", phase_progress = 25, attempt = 1 });
        var res = await client.SendAsync(req);
        Assert.Equal(HttpStatusCode.NoContent, res.StatusCode);

        var published = Assert.Single(recorder.Events);
        Assert.Equal(importId, published.Id);
        Assert.Equal(RecipeImportPhase.Transcribing, published.Phase);
        Assert.Equal(25, published.PhaseProgress);
    }

    [Fact]
    public async Task Rate_Limit_Triggers_429_After_Burst()
    {
        // This test must run against a client WITHOUT the rate-limit
        // bypass header — otherwise the limiter is disabled.
        var importId = await SeedImportAsync();
        var token = SignToken(importId);

        using var burstClient = _factory.CreateClient(); // no bypass header
        burstClient.DefaultRequestHeaders.Add(InternalOnlyMiddleware.TestBypassHeader, "true");

        HttpStatusCode? lastStatus = null;
        var got429 = false;
        for (var i = 0; i < 510; i++)
        {
            var req = new HttpRequestMessage(
                HttpMethod.Post, $"/api/internal/imports/{importId}/progress");
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            req.Content = JsonContent.Create(new
            {
                // Keep progress monotonic so the domain doesn't reject
                // within-test — but what matters is the rate-limit.
                phase = "transcribing",
                phase_progress = 20,
                attempt = 1,
            });
            var res = await burstClient.SendAsync(req);
            lastStatus = res.StatusCode;
            if (res.StatusCode == HttpStatusCode.TooManyRequests)
            {
                got429 = true;
                break;
            }
        }

        Assert.True(got429,
            $"Expected at least one 429 within 510 requests; last status = {lastStatus}");
    }
}

/// <summary>Internal recorder for import-progress publishes — the generic
/// <c>RecordingLiveSyncPublisher</c> in the meal-plan tests lives in a
/// different file; this one is scoped to the single method this file
/// cares about.</summary>
internal sealed class RecordingImportProgressPublisher : ILiveSyncPublisher
{
    public List<RecipeImport> Events { get; } = new();

    public Task MealPlanSlotChangedAsync(
        Guid groupId, Guid planId, Guid slotId, string weekStart,
        LiveSyncAction action, CancellationToken ct = default) => Task.CompletedTask;
    public Task MealPlanChangedAsync(
        Guid groupId, Guid planId, string weekStart, LiveSyncAction action,
        CancellationToken ct = default) => Task.CompletedTask;
    public Task ShoppingListItemChangedAsync(
        Guid groupId, Guid planId, Guid listId, Guid itemId,
        LiveSyncAction action, CancellationToken ct = default) => Task.CompletedTask;

    public Task RecipeImportProgressChangedAsync(
        RecipeImport import, CancellationToken ct = default)
    {
        Events.Add(import);
        return Task.CompletedTask;
    }
}
