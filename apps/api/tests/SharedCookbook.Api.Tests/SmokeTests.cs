using System.Net;
using SharedCookbook.Api.Tests.Infrastructure;
using Xunit;

namespace SharedCookbook.Api.Tests;

/// <summary>
/// Smoke test — verifies that the WebApplicationFactory boots the API host.
/// The /api/health assertion lives in <see cref="HealthEndpointTests"/>.
/// </summary>
public class SmokeTests : IClassFixture<SharedCookbookWebApplicationFactory>
{
    private readonly SharedCookbookWebApplicationFactory _factory;

    public SmokeTests(SharedCookbookWebApplicationFactory factory)
    {
        _factory = factory;
    }

    [Fact]
    public async Task Host_Starts_And_Returns_404_For_Unknown_Route()
    {
        using var client = _factory.CreateClient();

        var response = await client.GetAsync("/this-route-does-not-exist");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }
}
