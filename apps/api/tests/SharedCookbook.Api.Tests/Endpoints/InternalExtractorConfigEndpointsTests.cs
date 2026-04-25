using System.Net;
using System.Net.Http.Json;
using SharedCookbook.Api.Endpoints;
using SharedCookbook.Api.Services;
using SharedCookbook.Api.Tests.Infrastructure;
using SharedCookbook.Domain.Entities;
using SharedCookbook.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace SharedCookbook.Api.Tests.Endpoints;

/// <summary>
/// CFG-0 — integration tests for the Python-facing internal surface.
/// Exercises the docker-internal trust-boundary gate via
/// <see cref="InternalOnlyMiddleware.TestBypassHeader"/>, verifies the
/// seeded registry is fully exposed over the internal route, and
/// exercises the no-op refresh stub the E2E gate relies on.
///
/// External reject is covered by the dedicated
/// <see cref="Services.InternalOnlyMiddlewareTests"/> suite; here we
/// focus on the endpoint's business surface once the middleware has
/// passed us through.
/// </summary>
public class InternalExtractorConfigEndpointsTests
    : IClassFixture<SharedCookbookWebApplicationFactory>, IAsyncLifetime
{
    private readonly SharedCookbookWebApplicationFactory _factory;
    private HttpClient _client = null!;

    public InternalExtractorConfigEndpointsTests(SharedCookbookWebApplicationFactory factory)
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
        db.ExtractorConfigHistories.RemoveRange(db.ExtractorConfigHistories);
        await db.SaveChangesAsync();

        var existing = await db.ExtractorConfigs.ToListAsync();
        db.ExtractorConfigs.RemoveRange(existing);
        await db.SaveChangesAsync();
        var now = DateTimeOffset.UtcNow;
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

    [Fact]
    public async Task Internal_List_Returns_All_Seeded_Keys()
    {
        var res = await _client.GetAsync("/api/internal/extractor-config/");
        res.EnsureSuccessStatusCode();

        var body = await res.Content.ReadFromJsonAsync<InternalExtractorConfigEndpoints.InternalConfigListResponse>();
        Assert.NotNull(body);
        Assert.Equal(ExtractorConfigDefaults.All.Count, body!.Items.Length);
        var keys = body.Items.Select(i => i.Key).ToHashSet();
        foreach (var entry in ExtractorConfigDefaults.All)
        {
            Assert.Contains(entry.Key, keys);
        }
    }

    [Fact]
    public async Task Internal_List_Unauthenticated_Request_Succeeds_When_Internal()
    {
        // No Authorization header is required — the internal route lives
        // on the docker-internal trust boundary.
        var res = await _client.GetAsync("/api/internal/extractor-config/");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
    }

    [Fact]
    public async Task Internal_Refresh_Returns_204()
    {
        var res = await _client.PostAsync("/api/internal/extractor-config/refresh", null);
        Assert.Equal(HttpStatusCode.NoContent, res.StatusCode);
    }

    [Fact]
    public async Task Internal_List_External_Origin_Is_Rejected_By_Middleware()
    {
        using var externalClient = _factory.CreateRateLimitBypassingClient();
        // Deliberately omit the test-bypass header — TestServer sets
        // RemoteIpAddress=null so InternalOnlyMiddleware rejects with
        // 404 (same behaviour as an external caller).
        var res = await externalClient.GetAsync("/api/internal/extractor-config/");
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }
}
