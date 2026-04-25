using System.Net;
using System.Text.Json;
using SharedCookbook.Api.Tests.Infrastructure;
using Microsoft.AspNetCore.Hosting;
using Xunit;

namespace SharedCookbook.Api.Tests.Endpoints;

/// <summary>
/// Swagger/OpenAPI exposure. The spec + UI must be reachable in
/// Development; in non-Development environments the paths must 404 so
/// the production deployment doesn't leak the schema.
/// </summary>
public class OpenApiEndpointTests
{
    [Fact]
    public async Task Swagger_Json_Is_Reachable_In_Development()
    {
        await using var factory = new DevelopmentFactory();
        using var client = factory.CreateClient();

        var resp = await client.GetAsync("/api/swagger/v1/swagger.json");

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        Assert.StartsWith("application/json", resp.Content.Headers.ContentType?.MediaType);
        var json = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        // Must include our public health route at minimum.
        Assert.True(doc.RootElement.GetProperty("paths").TryGetProperty("/api/health", out _));
    }

    [Fact]
    public async Task Swagger_Ui_Is_Reachable_In_Development()
    {
        await using var factory = new DevelopmentFactory();
        using var client = factory.CreateClient();

        var resp = await client.GetAsync("/api/swagger/index.html");

        // Swashbuckle redirects `/swagger` → `/swagger/index.html` and serves HTML there.
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
    }

    [Fact]
    public async Task Swagger_Json_Is_Hidden_Outside_Development()
    {
        await using var factory = new SharedCookbookWebApplicationFactory();
        using var client = factory.CreateClient();

        var resp = await client.GetAsync("/api/swagger/v1/swagger.json");

        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
    }

    /// <summary>
    /// Sub-factory that forces the OpenAPI docs on via configuration
    /// while keeping the Testing environment (so the real Postgres
    /// bootstrap in Program.cs stays skipped).
    /// </summary>
    private sealed class DevelopmentFactory : SharedCookbookWebApplicationFactory
    {
        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            base.ConfigureWebHost(builder);
            builder.UseSetting("OpenApi:Enabled", "true");
        }
    }
}
