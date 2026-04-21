using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using FamilienKochbuch.Api.Endpoints;
using FamilienKochbuch.Api.Tests.Infrastructure;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace FamilienKochbuch.Api.Tests.Endpoints;

/// <summary>
/// CFG-0 — integration tests for the admin extractor-config surface.
/// Exercises auth (anonymous 401, non-admin 403, admin 200), full-list
/// + single-key reads, happy-path PUT with version-bump + history row,
/// range / version / key validation errors, and the reset-to-default
/// flow. Uses the shared <see cref="FamilienKochbuchWebApplicationFactory"/>
/// pattern (SQLite in-memory, real Program.cs wiring).
/// </summary>
public class AdminExtractorConfigEndpointsTests
    : IClassFixture<FamilienKochbuchWebApplicationFactory>, IAsyncLifetime
{
    private readonly FamilienKochbuchWebApplicationFactory _factory;
    private HttpClient _client = null!;

    public AdminExtractorConfigEndpointsTests(FamilienKochbuchWebApplicationFactory factory)
    {
        _factory = factory;
    }

    public async Task InitializeAsync()
    {
        _client = _factory.CreateRateLimitBypassingClient(
            new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions
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
        db.ExtractorConfigHistories.RemoveRange(db.ExtractorConfigHistories);
        db.RefreshTokens.RemoveRange(db.RefreshTokens);
        db.AppInvites.RemoveRange(db.AppInvites);
        var nonAdmin = db.Users.Where(u => u.Email != "admin@test.local");
        db.Users.RemoveRange(nonAdmin);
        await db.SaveChangesAsync();

        // Re-seed ExtractorConfig rows to their defaults in case a
        // prior test mutated them (ResetAsync is per-test; the
        // factory reuses one DB per class-fixture).
        await ReseedConfigAsync(db);
    }

    private static async Task ReseedConfigAsync(AppDbContext db)
    {
        var now = DateTimeOffset.UtcNow;
        var existing = await db.ExtractorConfigs.ToListAsync();
        db.ExtractorConfigs.RemoveRange(existing);
        await db.SaveChangesAsync();
        foreach (var entry in ExtractorConfigDefaults.All)
        {
            db.ExtractorConfigs.Add(new ExtractorConfig(
                key: entry.Key,
                valueJson: entry.DefaultValueJson,
                valueType: entry.ValueType,
                updatedAt: now,
                updatedBy: null));
        }
        await db.SaveChangesAsync();
    }

    private async Task<AuthEndpoints.AuthResponse> LoginAdminAsync() =>
        await LoginAsync("admin@test.local", "AdminPassword123!");

    private async Task<AuthEndpoints.AuthResponse> LoginAsync(string email, string password)
    {
        using var client = _factory.CreateRateLimitBypassingClient(
            new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { HandleCookies = true });
        var response = await client.PostAsJsonAsync("/api/auth/login",
            new AuthEndpoints.LoginRequest(email, password));
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadFromJsonAsync<AuthEndpoints.AuthResponse>())!;
    }

    private async Task<(Guid userId, string token)> SignupRegularUserAsync(string email, string displayName)
    {
        var adminToken = (await LoginAdminAsync()).AccessToken;
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

    private HttpRequestMessage BuildAuthed(HttpMethod method, string path, string token, object? body = null)
    {
        var req = new HttpRequestMessage(method, path);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        if (body is not null) req.Content = JsonContent.Create(body);
        return req;
    }

    // ── Auth matrix ──────────────────────────────────────────────────

    [Fact]
    public async Task List_Anonymous_Returns_401()
    {
        var res = await _client.GetAsync("/api/admin/extractor-config");
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
    }

    [Fact]
    public async Task List_NonAdmin_Returns_403()
    {
        var (_, token) = await SignupRegularUserAsync("alice@ex.com", "Alice");
        var res = await _client.SendAsync(BuildAuthed(HttpMethod.Get, "/api/admin/extractor-config", token));
        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
    }

    [Fact]
    public async Task Put_NonAdmin_Returns_403()
    {
        var (_, token) = await SignupRegularUserAsync("bob@ex.com", "Bob");
        var res = await _client.SendAsync(BuildAuthed(
            HttpMethod.Put,
            "/api/admin/extractor-config/llm.structured.temperature",
            token,
            new { value = 0.5, expectedVersion = 0 }));
        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
    }

    // ── Admin happy paths ────────────────────────────────────────────

    [Fact]
    public async Task Admin_List_Returns_All_Seeded_Keys()
    {
        var admin = await LoginAdminAsync();
        var res = await _client.SendAsync(BuildAuthed(
            HttpMethod.Get, "/api/admin/extractor-config", admin.AccessToken));
        res.EnsureSuccessStatusCode();

        var body = await res.Content.ReadFromJsonAsync<AdminExtractorConfigEndpoints.ConfigListResponse>();
        Assert.NotNull(body);
        Assert.Equal(ExtractorConfigDefaults.All.Count, body!.Items.Length);
        var keys = body.Items.Select(i => i.Key).ToHashSet();
        foreach (var entry in ExtractorConfigDefaults.All)
        {
            Assert.Contains(entry.Key, keys);
        }
    }

    [Fact]
    public async Task Admin_Get_Single_Returns_Row_With_Empty_History()
    {
        var admin = await LoginAdminAsync();
        var res = await _client.SendAsync(BuildAuthed(
            HttpMethod.Get,
            "/api/admin/extractor-config/llm.structured.temperature",
            admin.AccessToken));
        res.EnsureSuccessStatusCode();

        var body = await res.Content.ReadFromJsonAsync<AdminExtractorConfigEndpoints.ConfigDetailResponse>();
        Assert.NotNull(body);
        Assert.Equal("llm.structured.temperature", body!.Item.Key);
        Assert.Equal("float", body.Item.Type);
        Assert.Empty(body.History);
    }

    [Fact]
    public async Task Admin_Get_Unknown_Key_Returns_404()
    {
        var admin = await LoginAdminAsync();
        var res = await _client.SendAsync(BuildAuthed(
            HttpMethod.Get,
            "/api/admin/extractor-config/does.not.exist",
            admin.AccessToken));
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }

    [Fact]
    public async Task Admin_Put_Valid_Value_Returns_200_Bumps_Version_Writes_History()
    {
        var admin = await LoginAdminAsync();
        var res = await _client.SendAsync(BuildAuthed(
            HttpMethod.Put,
            "/api/admin/extractor-config/llm.structured.temperature",
            admin.AccessToken,
            new { value = 0.5, expectedVersion = 0 }));
        res.EnsureSuccessStatusCode();

        var body = await res.Content.ReadFromJsonAsync<AdminExtractorConfigEndpoints.ConfigItemDto>();
        Assert.NotNull(body);
        Assert.Equal(1, body!.Version);
        Assert.Equal(0.5, body.Value.GetDouble());
        Assert.NotNull(body.UpdatedBy);
        Assert.Equal(admin.User.Id, body.UpdatedBy!.Id);

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var row = await db.ExtractorConfigs.AsNoTracking()
            .SingleAsync(c => c.Key == "llm.structured.temperature");
        Assert.Equal(1, row.Version);
        Assert.Equal("0.5", row.ValueJson);
        Assert.Equal(admin.User.Id, row.UpdatedBy);

        var history = await db.ExtractorConfigHistories.AsNoTracking()
            .Where(h => h.Key == "llm.structured.temperature")
            .ToListAsync();
        Assert.Single(history);
        Assert.Equal("0", history[0].OldValueJson);
        Assert.Equal("0.5", history[0].NewValueJson);
        Assert.Equal(admin.User.Id, history[0].ChangedBy);
    }

    [Fact]
    public async Task Admin_Put_OutOfRange_Value_Returns_400_InvalidValue()
    {
        var admin = await LoginAdminAsync();
        var res = await _client.SendAsync(BuildAuthed(
            HttpMethod.Put,
            "/api/admin/extractor-config/llm.structured.temperature",
            admin.AccessToken,
            new { value = 99.0, expectedVersion = 0 }));
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);

        var json = await res.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        Assert.Equal("invalid_value", doc.RootElement.GetProperty("code").GetString());
    }

    [Fact]
    public async Task Admin_Put_Wrong_Type_Returns_400_InvalidValue()
    {
        var admin = await LoginAdminAsync();
        var res = await _client.SendAsync(BuildAuthed(
            HttpMethod.Put,
            "/api/admin/extractor-config/feature.video_import_enabled",
            admin.AccessToken,
            new { value = "yes", expectedVersion = 0 }));
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);

        var json = await res.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        Assert.Equal("invalid_value", doc.RootElement.GetProperty("code").GetString());
    }

    [Fact]
    public async Task Admin_Put_Stale_ExpectedVersion_Returns_409()
    {
        var admin = await LoginAdminAsync();
        // First edit: bumps Version from 0 → 1.
        var first = await _client.SendAsync(BuildAuthed(
            HttpMethod.Put,
            "/api/admin/extractor-config/llm.structured.temperature",
            admin.AccessToken,
            new { value = 0.3, expectedVersion = 0 }));
        first.EnsureSuccessStatusCode();

        // Second edit sends stale expectedVersion = 0 (should be 1).
        var stale = await _client.SendAsync(BuildAuthed(
            HttpMethod.Put,
            "/api/admin/extractor-config/llm.structured.temperature",
            admin.AccessToken,
            new { value = 0.7, expectedVersion = 0 }));
        Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode);

        var json = await stale.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        Assert.Equal("version_mismatch", doc.RootElement.GetProperty("code").GetString());
    }

    [Fact]
    public async Task Admin_Put_Unknown_Key_Returns_404()
    {
        var admin = await LoginAdminAsync();
        var res = await _client.SendAsync(BuildAuthed(
            HttpMethod.Put,
            "/api/admin/extractor-config/does.not.exist",
            admin.AccessToken,
            new { value = 1, expectedVersion = 0 }));
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }

    [Fact]
    public async Task Admin_Reset_Restores_Default_And_Writes_History()
    {
        var admin = await LoginAdminAsync();
        // Step 1: change temperature from default (0) to 0.8.
        var put = await _client.SendAsync(BuildAuthed(
            HttpMethod.Put,
            "/api/admin/extractor-config/llm.structured.temperature",
            admin.AccessToken,
            new { value = 0.8, expectedVersion = 0 }));
        put.EnsureSuccessStatusCode();

        // Step 2: reset.
        var reset = await _client.SendAsync(BuildAuthed(
            HttpMethod.Post,
            "/api/admin/extractor-config/llm.structured.temperature/reset",
            admin.AccessToken));
        reset.EnsureSuccessStatusCode();

        var body = await reset.Content.ReadFromJsonAsync<AdminExtractorConfigEndpoints.ConfigItemDto>();
        Assert.NotNull(body);
        Assert.Equal(2, body!.Version);
        Assert.Equal(0d, body.Value.GetDouble());

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        // SQLite can't ORDER BY DateTimeOffset — fetch + sort in
        // memory. In production Postgres this is a single server-side
        // query (see endpoint for the mirrored pattern).
        var rawHistory = await db.ExtractorConfigHistories.AsNoTracking()
            .Where(h => h.Key == "llm.structured.temperature")
            .ToListAsync();
        var history = rawHistory.OrderBy(h => h.ChangedAt).ToList();
        Assert.Equal(2, history.Count);
        Assert.Equal("0.8", history[1].OldValueJson);
        Assert.Equal("0", history[1].NewValueJson);
    }

    [Fact]
    public async Task Admin_Reset_Unknown_Key_Returns_404()
    {
        var admin = await LoginAdminAsync();
        var res = await _client.SendAsync(BuildAuthed(
            HttpMethod.Post,
            "/api/admin/extractor-config/does.not.exist/reset",
            admin.AccessToken));
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }

    [Fact]
    public async Task Admin_Put_Prompt_Too_Short_Returns_400()
    {
        var admin = await LoginAdminAsync();
        var res = await _client.SendAsync(BuildAuthed(
            HttpMethod.Put,
            "/api/admin/extractor-config/llm.structured.system_prompt",
            admin.AccessToken,
            new { value = "too short", expectedVersion = 0 }));
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    [Fact]
    public async Task Admin_Put_Prompt_Too_Long_Returns_400()
    {
        var admin = await LoginAdminAsync();
        var oversized = new string('x', 20_001);
        var res = await _client.SendAsync(BuildAuthed(
            HttpMethod.Put,
            "/api/admin/extractor-config/llm.structured.system_prompt",
            admin.AccessToken,
            new { value = oversized, expectedVersion = 0 }));
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    [Fact]
    public async Task Admin_Put_Max_Tokens_Above_Cap_Returns_400()
    {
        var admin = await LoginAdminAsync();
        var res = await _client.SendAsync(BuildAuthed(
            HttpMethod.Put,
            "/api/admin/extractor-config/llm.structured.max_completion_tokens",
            admin.AccessToken,
            new { value = 999_999, expectedVersion = 0 }));
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    [Fact]
    public async Task Admin_Put_Bool_Flag_Accepts_False()
    {
        var admin = await LoginAdminAsync();
        var res = await _client.SendAsync(BuildAuthed(
            HttpMethod.Put,
            "/api/admin/extractor-config/feature.video_import_enabled",
            admin.AccessToken,
            new { value = false, expectedVersion = 0 }));
        res.EnsureSuccessStatusCode();

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var row = await db.ExtractorConfigs.AsNoTracking()
            .SingleAsync(c => c.Key == "feature.video_import_enabled");
        Assert.Equal("false", row.ValueJson);
    }
}
