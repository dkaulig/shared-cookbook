using System.Globalization;
using System.Net;
using System.Text;
using SharedCookbook.Api.Endpoints;
using SharedCookbook.Api.Services;
using SharedCookbook.Api.Tests.Infrastructure;
using SharedCookbook.Infrastructure.Services;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace SharedCookbook.Api.Tests.Endpoints;

/// <summary>
/// Integration tests for <c>GET /api/photos/{**path}</c>. Uses a
/// <see cref="FakeSeaweedFsFiler"/> injected as the named HTTP client's
/// primary handler so the proxy path never touches a real SeaweedFS.
/// </summary>
public class PhotoProxyEndpointsTests : IClassFixture<PhotoProxyEndpointsTests.Factory>
{
    private readonly Factory _factory;

    public PhotoProxyEndpointsTests(Factory factory)
    {
        _factory = factory;
        _factory.Filer.Clear();
    }

    private string Sign(string path) => _factory.Signing.SignUrl($"/api/photos/{path}", path);

    // ── Happy path ──────────────────────────────────────────────────

    [Fact]
    public async Task Proxy_ValidSignature_Returns_Body_And_ContentType()
    {
        var path = "recipes/happy.png";
        var payload = new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A };
        _factory.Filer.Put(path, payload, "image/png");

        using var client = _factory.CreateClient();
        var response = await client.GetAsync(Sign(path));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("image/png", response.Content.Headers.ContentType?.MediaType);
        var bytes = await response.Content.ReadAsByteArrayAsync();
        Assert.Equal(payload, bytes);
    }

    [Fact]
    public async Task Proxy_ValidSignature_SetsCacheControlHeader()
    {
        var path = "recipes/cache.png";
        _factory.Filer.Put(path, new byte[] { 1, 2, 3 }, "image/png");

        using var client = _factory.CreateClient();
        var response = await client.GetAsync(Sign(path));

        response.EnsureSuccessStatusCode();
        var cacheControl = response.Headers.CacheControl;
        Assert.NotNull(cacheControl);
        Assert.True(cacheControl!.Private);
        Assert.Equal(TimeSpan.FromHours(1), cacheControl.MaxAge);
    }

    // ── Missing / invalid signature ─────────────────────────────────

    [Fact]
    public async Task Proxy_MissingSig_Returns403()
    {
        var path = "recipes/missing-sig.png";
        _factory.Filer.Put(path, new byte[] { 1 }, "image/png");

        using var client = _factory.CreateClient();
        var exp = DateTimeOffset.UtcNow.AddHours(2).ToUnixTimeSeconds();
        var response = await client.GetAsync(
            $"/api/photos/{path}?exp={exp.ToString(CultureInfo.InvariantCulture)}");

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task Proxy_MissingExp_Returns403()
    {
        var path = "recipes/missing-exp.png";
        _factory.Filer.Put(path, new byte[] { 1 }, "image/png");

        using var client = _factory.CreateClient();
        var response = await client.GetAsync($"/api/photos/{path}?sig=irrelevant");

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task Proxy_InvalidSig_Returns403()
    {
        var path = "recipes/bad-sig.png";
        _factory.Filer.Put(path, new byte[] { 1 }, "image/png");

        using var client = _factory.CreateClient();
        var exp = DateTimeOffset.UtcNow.AddHours(2).ToUnixTimeSeconds();
        var response = await client.GetAsync(
            $"/api/photos/{path}?sig=AAAAbogusAAAA&exp={exp.ToString(CultureInfo.InvariantCulture)}");

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task Proxy_ExpiredUrl_Returns403()
    {
        var path = "recipes/expired.png";
        _factory.Filer.Put(path, new byte[] { 1 }, "image/png");

        var signed = Sign(path);
        // Replace the exp with a timestamp in the past while keeping the sig.
        var query = signed.Split('?')[1].Split('&');
        var sig = query[0].Split('=')[1];
        var pastExp = DateTimeOffset.UtcNow.AddHours(-1).ToUnixTimeSeconds();

        using var client = _factory.CreateClient();
        var response = await client.GetAsync(
            $"/api/photos/{path}?sig={sig}&exp={pastExp.ToString(CultureInfo.InvariantCulture)}");

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task Proxy_TamperedPath_Returns403()
    {
        // Sign path A, request path B with the same sig/exp.
        var pathA = "recipes/original.png";
        var pathB = "recipes/tampered.png";
        _factory.Filer.Put(pathA, new byte[] { 1 }, "image/png");
        _factory.Filer.Put(pathB, new byte[] { 2 }, "image/png");

        var signedA = Sign(pathA);
        var query = signedA.Split('?')[1].Split('&');
        var sig = query[0].Split('=')[1];
        var exp = query[1].Split('=')[1];

        using var client = _factory.CreateClient();
        var response = await client.GetAsync(
            $"/api/photos/{pathB}?sig={sig}&exp={exp}");

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task Proxy_ExpNotANumber_Returns403()
    {
        var path = "recipes/non-number-exp.png";
        _factory.Filer.Put(path, new byte[] { 1 }, "image/png");

        using var client = _factory.CreateClient();
        var response = await client.GetAsync($"/api/photos/{path}?sig=x&exp=not-a-number");

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    // ── Valid signature, object missing on filer ────────────────────

    [Fact]
    public async Task Proxy_ValidSignature_FilerMissing_Returns404()
    {
        var path = "recipes/never-uploaded.png";
        // Intentionally no Filer.Put.

        using var client = _factory.CreateClient();
        var response = await client.GetAsync(Sign(path));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    // ── Anonymous access (no JWT) is allowed ────────────────────────

    [Fact]
    public async Task Proxy_AllowsAnonymous_WhenSignatureValid()
    {
        var path = "recipes/public.png";
        var payload = Encoding.UTF8.GetBytes("bytes");
        _factory.Filer.Put(path, payload, "image/png");

        using var client = _factory.CreateClient();
        // No Authorization header set.
        var response = await client.GetAsync(Sign(path));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    // ── Web-app factory wiring ──────────────────────────────────────

    /// <summary>
    /// Minimal factory for the proxy endpoint tests: doesn't need the
    /// full DB / Identity seed, just the photo-related DI graph. We
    /// still lean on <see cref="SharedCookbookWebApplicationFactory"/>
    /// so the host pipeline (auth middleware, CORS, etc.) matches
    /// production.
    /// </summary>
    public class Factory : SharedCookbookWebApplicationFactory
    {
        public FakeSeaweedFsFiler Filer { get; } = new();

        public ImageSigningService Signing => Services.GetRequiredService<ImageSigningService>();

        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            base.ConfigureWebHost(builder);
            builder.UseSetting("SeaweedFS:FilerUrl", "http://test-filer.invalid");
            builder.UseSetting("Images:SignatureValidityHours", "2");

            builder.ConfigureServices(services =>
            {
                // Route the named filer client through the in-memory fake.
                services
                    .AddHttpClient(SeaweedFsPhotoStorage.FilerHttpClientName)
                    .ConfigurePrimaryHttpMessageHandler(() => Filer.Handler);
            });
        }
    }
}
