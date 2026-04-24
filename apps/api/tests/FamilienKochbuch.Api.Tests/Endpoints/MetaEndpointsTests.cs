using System.Net;
using System.Net.Http.Json;
using FamilienKochbuch.Api.Endpoints;
using FamilienKochbuch.Api.Tests.Infrastructure;
using Xunit;

namespace FamilienKochbuch.Api.Tests.Endpoints;

/// <summary>
/// REL-7 — contract tests for <c>GET /api/meta/features</c>. The
/// frontend's <c>useFeatures()</c> hook pings this endpoint
/// anonymously and the response shape is load-bearing for the entire
/// "AI-optional" UX, so we pin:
///
/// <list type="bullet">
/// <item>The three configuration states: AI off, Azure, Ollama.</item>
/// <item>The JSON-LD flag is always-true regardless of AI state (REL-8
/// runs without credentials).</item>
/// <item>The response is cacheable + anonymous.</item>
/// </list>
///
/// Does NOT use <see cref="IClassFixture{TFixture}"/> — each test needs
/// its own <see cref="FamilienKochbuchWebApplicationFactory"/> so the
/// <c>WithAiConfig</c> override doesn't bleed across tests via a shared
/// host instance.
/// </summary>
public class MetaEndpointsTests
{
    private static async Task<(FamilienKochbuchWebApplicationFactory factory, HttpClient client)> BuildAsync(
        bool enabled, string provider)
    {
        var factory = new FamilienKochbuchWebApplicationFactory()
            .WithAiConfig(enabled: enabled, provider: provider);
        await factory.InitializeAsync();
        var client = factory.CreateRateLimitBypassingClient();
        return (factory, client);
    }

    [Fact]
    public async Task AiOff_Default_Returns_AllFlagsFalse_ExceptJsonld()
    {
        var (factory, client) = await BuildAsync(enabled: false, provider: "disabled");
        try
        {
            var response = await client.GetAsync("/api/meta/features");
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);

            var body = await response.Content.ReadFromJsonAsync<MetaEndpoints.FeaturesResponse>();
            Assert.NotNull(body);
            Assert.False(body!.Ai.Enabled);
            Assert.Null(body.Ai.Provider);
            Assert.False(body.Ai.Features.UrlImport);
            Assert.False(body.Ai.Features.VideoImport);
            Assert.False(body.Ai.Features.PhotoImport);
            Assert.False(body.Ai.Features.Chat);
            Assert.True(body.Ai.Features.JsonldImport);
        }
        finally
        {
            client.Dispose();
            await factory.DisposeAsync();
        }
    }

    [Fact]
    public async Task AiEnabled_Azure_Returns_AzureProvider_AllFlagsTrue()
    {
        var (factory, client) = await BuildAsync(enabled: true, provider: "azure");
        try
        {
            var response = await client.GetAsync("/api/meta/features");
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);

            var body = await response.Content.ReadFromJsonAsync<MetaEndpoints.FeaturesResponse>();
            Assert.NotNull(body);
            Assert.True(body!.Ai.Enabled);
            Assert.Equal("azure", body.Ai.Provider);
            Assert.True(body.Ai.Features.UrlImport);
            Assert.True(body.Ai.Features.VideoImport);
            Assert.True(body.Ai.Features.PhotoImport);
            Assert.True(body.Ai.Features.Chat);
            Assert.True(body.Ai.Features.JsonldImport);
        }
        finally
        {
            client.Dispose();
            await factory.DisposeAsync();
        }
    }

    [Fact]
    public async Task AiEnabled_Ollama_Returns_OllamaProvider_AllFlagsTrue()
    {
        var (factory, client) = await BuildAsync(enabled: true, provider: "ollama");
        try
        {
            var response = await client.GetAsync("/api/meta/features");
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);

            var body = await response.Content.ReadFromJsonAsync<MetaEndpoints.FeaturesResponse>();
            Assert.NotNull(body);
            Assert.True(body!.Ai.Enabled);
            Assert.Equal("ollama", body.Ai.Provider);
            Assert.True(body.Ai.Features.Chat);
        }
        finally
        {
            client.Dispose();
            await factory.DisposeAsync();
        }
    }

    [Fact]
    public async Task AiEnabled_WithUnknownProvider_TreatedAsDisabled()
    {
        // Typo or unsupported provider value → fall through to "AI off"
        // so operators see the UI-gated state and fix their env.
        var (factory, client) = await BuildAsync(enabled: true, provider: "banana");
        try
        {
            var response = await client.GetAsync("/api/meta/features");
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);

            var body = await response.Content.ReadFromJsonAsync<MetaEndpoints.FeaturesResponse>();
            Assert.NotNull(body);
            Assert.False(body!.Ai.Enabled);
            Assert.Null(body.Ai.Provider);
        }
        finally
        {
            client.Dispose();
            await factory.DisposeAsync();
        }
    }

    [Fact]
    public async Task FeaturesEndpoint_IsAnonymous_NoAuthRequired()
    {
        var (factory, client) = await BuildAsync(enabled: false, provider: "disabled");
        try
        {
            client.DefaultRequestHeaders.Authorization = null;
            var response = await client.GetAsync("/api/meta/features");
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        }
        finally
        {
            client.Dispose();
            await factory.DisposeAsync();
        }
    }

    [Fact]
    public async Task FeaturesEndpoint_SetsShortCacheHeader()
    {
        var (factory, client) = await BuildAsync(enabled: true, provider: "azure");
        try
        {
            var response = await client.GetAsync("/api/meta/features");

            Assert.NotNull(response.Headers.CacheControl);
            Assert.True(response.Headers.CacheControl!.Public);
            Assert.Equal(TimeSpan.FromSeconds(60), response.Headers.CacheControl.MaxAge);
        }
        finally
        {
            client.Dispose();
            await factory.DisposeAsync();
        }
    }
}
