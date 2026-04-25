using System.Net;
using SharedCookbook.Api.Tests.Infrastructure;
using Xunit;

namespace SharedCookbook.Api.Tests.Hubs;

/// <summary>
/// P3-8 security — exercises the per-IP rate limit on
/// <c>POST /api/hubs/live/negotiate</c>. Anonymous negotiate floods would
/// otherwise burn CPU on JWT validation before [Authorize] rejects them.
/// Must NOT use the <c>X-Test-Disable-RateLimit</c> header so the limiter
/// stays engaged (<see cref="SharedCookbookWebApplicationFactory"/>
/// normally adds it via <c>CreateRateLimitBypassingClient</c>).
/// </summary>
public class LiveSyncHubRateLimitTests : IClassFixture<SharedCookbookWebApplicationFactory>
{
    private readonly SharedCookbookWebApplicationFactory _factory;

    public LiveSyncHubRateLimitTests(SharedCookbookWebApplicationFactory factory)
    {
        _factory = factory;
    }

    [Fact]
    public async Task ThirtyFirst_Negotiate_In_One_Window_Returns_429()
    {
        using var client = _factory.CreateClient();

        // 30 anonymous negotiate attempts all get 401 (unauthenticated)
        // but each one consumes a permit on the Hub partition.
        for (var i = 0; i < 30; i++)
        {
            var r = await client.PostAsync("/api/hubs/live/negotiate?negotiateVersion=1", null);
            Assert.Equal(HttpStatusCode.Unauthorized, r.StatusCode);
        }

        // 31st must be rate-limited (429) — before auth even runs.
        var throttled = await client.PostAsync("/api/hubs/live/negotiate?negotiateVersion=1", null);
        Assert.Equal(HttpStatusCode.TooManyRequests, throttled.StatusCode);
    }
}
