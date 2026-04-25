using System.Net;
using System.Text.Json;
using SharedCookbook.Api.Tests.Infrastructure;
using Xunit;

namespace SharedCookbook.Api.Tests;

/// <summary>
/// Contract tests for the <c>GET /api/health</c> endpoint.
/// Shape: <c>{ "status": "ok", "timestamp": "&lt;ISO-8601 UTC&gt;" }</c>.
/// </summary>
public class HealthEndpointTests : IClassFixture<SharedCookbookWebApplicationFactory>
{
    private readonly SharedCookbookWebApplicationFactory _factory;

    public HealthEndpointTests(SharedCookbookWebApplicationFactory factory)
    {
        _factory = factory;
    }

    [Fact]
    public async Task Get_Health_Returns_200_Ok()
    {
        using var client = _factory.CreateClient();

        var response = await client.GetAsync("/api/health");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task Get_Health_Returns_Json_With_Status_Ok()
    {
        using var client = _factory.CreateClient();

        var response = await client.GetAsync("/api/health");
        response.EnsureSuccessStatusCode();

        Assert.Equal("application/json", response.Content.Headers.ContentType?.MediaType);

        var body = await response.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(body);
        var root = doc.RootElement;

        Assert.Equal(JsonValueKind.Object, root.ValueKind);
        Assert.Equal("ok", root.GetProperty("status").GetString());
    }

    [Fact]
    public async Task Get_Health_Returns_Iso8601_Utc_Timestamp()
    {
        using var client = _factory.CreateClient();

        var response = await client.GetAsync("/api/health");
        response.EnsureSuccessStatusCode();

        var body = await response.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(body);
        var timestamp = doc.RootElement.GetProperty("timestamp").GetString();

        Assert.False(string.IsNullOrWhiteSpace(timestamp));
        // Must round-trip as a UTC ISO-8601 timestamp.
        var parsed = DateTimeOffset.Parse(timestamp!, null, System.Globalization.DateTimeStyles.RoundtripKind);
        Assert.Equal(TimeSpan.Zero, parsed.Offset);
    }
}
