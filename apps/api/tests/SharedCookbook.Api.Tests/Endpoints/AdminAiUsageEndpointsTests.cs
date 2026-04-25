using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using SharedCookbook.Api.Endpoints;
using SharedCookbook.Api.Tests.Infrastructure;
using SharedCookbook.Domain.Entities;
using SharedCookbook.Domain.Enums;
using SharedCookbook.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace SharedCookbook.Api.Tests.Endpoints;

/// <summary>
/// Integration tests for the PF2 admin endpoint
/// <c>GET /api/admin/ai-usage</c>. Covers:
/// auth (anonymous 401, non-admin 403, admin 200), grand totals across
/// <see cref="RecipeImport"/> + <see cref="ChatUsageLog"/>, empty-range
/// zero totals, and <c>groupBy=model</c> correctness.
/// </summary>
public class AdminAiUsageEndpointsTests
    : IClassFixture<SharedCookbookWebApplicationFactory>, IAsyncLifetime
{
    private readonly SharedCookbookWebApplicationFactory _factory;
    private HttpClient _client = null!;

    public AdminAiUsageEndpointsTests(SharedCookbookWebApplicationFactory factory)
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
        db.ChatUsageLogs.RemoveRange(db.ChatUsageLogs);
        db.RecipeImports.RemoveRange(db.RecipeImports);
        db.RefreshTokens.RemoveRange(db.RefreshTokens);
        db.AppInvites.RemoveRange(db.AppInvites);
        var nonAdmin = db.Users.Where(u => u.Email != "admin@test.local");
        db.Users.RemoveRange(nonAdmin);
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

    // ── Auth matrix ──────────────────────────────────────────────────

    [Fact]
    public async Task Anonymous_Gets_401()
    {
        var response = await _client.GetAsync("/api/admin/ai-usage");
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Non_Admin_User_Gets_403()
    {
        var (_, token) = await SignupRegularUserAsync("regular@ex.com", "Reggie");

        using var req = new HttpRequestMessage(HttpMethod.Get, "/api/admin/ai-usage");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task Admin_Empty_Range_Returns_Zero_Totals()
    {
        var admin = await LoginAdminAsync();

        using var req = new HttpRequestMessage(HttpMethod.Get, "/api/admin/ai-usage");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", admin.AccessToken);
        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(0, body.GetProperty("totalPromptTokens").GetInt64());
        Assert.Equal(0, body.GetProperty("totalCompletionTokens").GetInt64());
        Assert.Equal(0, body.GetProperty("totalCachedTokens").GetInt64());
        Assert.Equal(0m, body.GetProperty("totalUsd").GetDecimal());
        Assert.Equal(0m, body.GetProperty("totalEur").GetDecimal());
        Assert.Equal(0, body.GetProperty("groups").GetArrayLength());
    }

    // ── Aggregation ─────────────────────────────────────────────────

    [Fact]
    public async Task Admin_Aggregates_RecipeImport_And_ChatUsageLog_Rows()
    {
        await SeedUsageFixtureAsync();

        var admin = await LoginAdminAsync();
        using var req = new HttpRequestMessage(HttpMethod.Get, "/api/admin/ai-usage?groupBy=model");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", admin.AccessToken);
        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();

        // Fixture: 1M uncached input + 0 completion on gpt-4.1 via RecipeImport
        //          → $2.00 USD
        // Plus:    500k uncached input + 100k completion on gpt-5.1-chat via ChatUsageLog
        //          → (0.5 * 1.25) + (0.1 * 10.00) = $0.625 + $1.00 = $1.625
        // Total prompt = 1.5M; completion = 100k; USD = $3.625; EUR = $3.625 * 0.92 = 3.335.
        Assert.Equal(1_500_000, body.GetProperty("totalPromptTokens").GetInt64());
        Assert.Equal(100_000, body.GetProperty("totalCompletionTokens").GetInt64());
        Assert.Equal(0, body.GetProperty("totalCachedTokens").GetInt64());
        Assert.Equal(3.625m, body.GetProperty("totalUsd").GetDecimal());
        Assert.Equal(3.335m, body.GetProperty("totalEur").GetDecimal());

        var groups = body.GetProperty("groups").EnumerateArray().ToArray();
        Assert.Equal(2, groups.Length);
        // Sorted by USD desc — gpt-4.1 ($2) ahead of gpt-5.1-chat ($1.625).
        Assert.Equal("gpt-4.1", groups[0].GetProperty("key").GetString());
        Assert.Equal(2.00m, groups[0].GetProperty("usd").GetDecimal());
        Assert.Equal("gpt-5.1-chat", groups[1].GetProperty("key").GetString());
        Assert.Equal(1.625m, groups[1].GetProperty("usd").GetDecimal());
    }

    [Fact]
    public async Task Admin_GroupBy_User_Returns_Display_Name_Keys()
    {
        var (userId, _) = await SignupRegularUserAsync("reggie@ex.com", "Reggie");
        await SeedImportForUserAsync(userId);

        var admin = await LoginAdminAsync();
        using var req = new HttpRequestMessage(HttpMethod.Get, "/api/admin/ai-usage?groupBy=user");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", admin.AccessToken);
        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("user", body.GetProperty("groupBy").GetString());
        var groups = body.GetProperty("groups").EnumerateArray().ToArray();
        Assert.Single(groups);
        Assert.Equal("Reggie", groups[0].GetProperty("key").GetString());
    }

    [Fact]
    public async Task Admin_From_To_Filters_Out_Of_Range_Rows()
    {
        var (userId, _) = await SignupRegularUserAsync("reggie@ex.com", "Reggie");

        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var group = new Group("Fam", null, DateTimeOffset.UtcNow);
            db.Groups.Add(group);
            await db.SaveChangesAsync();

            // Old import — outside the query range.
            var oldImport = new RecipeImport(
                userId, group.Id, ImportSource.Url, "https://a",
                new DateTimeOffset(2025, 1, 1, 12, 0, 0, TimeSpan.Zero));
            oldImport.MarkRunning(50);
            oldImport.RecordUsage(1_000_000, 0, 0, "gpt-4.1");
            oldImport.MarkDone("{\"t\":\"x\"}", new DateTimeOffset(2025, 1, 1, 12, 5, 0, TimeSpan.Zero));
            db.RecipeImports.Add(oldImport);

            // Current import — inside.
            var newImport = new RecipeImport(
                userId, group.Id, ImportSource.Url, "https://b",
                new DateTimeOffset(2026, 4, 15, 12, 0, 0, TimeSpan.Zero));
            newImport.MarkRunning(50);
            newImport.RecordUsage(500_000, 0, 0, "gpt-4.1");
            newImport.MarkDone("{\"t\":\"x\"}", new DateTimeOffset(2026, 4, 15, 12, 5, 0, TimeSpan.Zero));
            db.RecipeImports.Add(newImport);
            await db.SaveChangesAsync();
        }

        var admin = await LoginAdminAsync();
        var from = new DateTimeOffset(2026, 4, 1, 0, 0, 0, TimeSpan.Zero).ToString("O");
        var to = new DateTimeOffset(2026, 5, 1, 0, 0, 0, TimeSpan.Zero).ToString("O");
        using var req = new HttpRequestMessage(
            HttpMethod.Get,
            $"/api/admin/ai-usage?from={Uri.EscapeDataString(from)}&to={Uri.EscapeDataString(to)}&groupBy=model");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", admin.AccessToken);
        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        // Only the 500k row remains.
        Assert.Equal(500_000, body.GetProperty("totalPromptTokens").GetInt64());
        Assert.Equal(1.00m, body.GetProperty("totalUsd").GetDecimal());
    }

    // ── Fixture helpers ────────────────────────────────────────────

    private async Task SeedUsageFixtureAsync()
    {
        var (userId, _) = await SignupRegularUserAsync("reggie@ex.com", "Reggie");

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var group = new Group("Fam", null, DateTimeOffset.UtcNow);
        db.Groups.Add(group);
        await db.SaveChangesAsync();

        var import = new RecipeImport(
            userId, group.Id, ImportSource.Url, "https://r", DateTimeOffset.UtcNow);
        import.MarkRunning(50);
        import.RecordUsage(1_000_000, 0, 0, "gpt-4.1");
        import.MarkDone("{\"t\":\"x\"}", DateTimeOffset.UtcNow);
        db.RecipeImports.Add(import);

        db.ChatUsageLogs.Add(new ChatUsageLog(
            userId, "sess-1", ChatUsageKind.ChatTurn,
            promptTokens: 500_000, completionTokens: 100_000,
            cachedPromptTokens: 0, modelDeployment: "gpt-5.1-chat",
            createdAt: DateTimeOffset.UtcNow));
        await db.SaveChangesAsync();
    }

    private async Task SeedImportForUserAsync(Guid userId)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var group = new Group("Fam", null, DateTimeOffset.UtcNow);
        db.Groups.Add(group);
        await db.SaveChangesAsync();

        var import = new RecipeImport(
            userId, group.Id, ImportSource.Url, "https://r", DateTimeOffset.UtcNow);
        import.MarkRunning(50);
        import.RecordUsage(100_000, 0, 50_000, "gpt-4.1");
        import.MarkDone("{\"t\":\"x\"}", DateTimeOffset.UtcNow);
        db.RecipeImports.Add(import);
        await db.SaveChangesAsync();
    }
}
