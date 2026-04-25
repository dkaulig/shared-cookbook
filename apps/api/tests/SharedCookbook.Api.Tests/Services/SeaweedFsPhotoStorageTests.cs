using System.Globalization;
using System.Net.Http;
using SharedCookbook.Api.Endpoints;
using SharedCookbook.Api.Services;
using SharedCookbook.Api.Tests.Infrastructure;
using SharedCookbook.Infrastructure.Services;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;

namespace SharedCookbook.Api.Tests.Services;

/// <summary>
/// Contract tests for the post-migration <see cref="SeaweedFsPhotoStorage"/>
/// — filer HTTP client + signed URLs, no S3 SDK. Exercises the real
/// <see cref="ImageSigningService"/> so the upload → GetPublicUrl → proxy
/// path roundtrips as the live stack will.
/// </summary>
public class SeaweedFsPhotoStorageTests
{
    private const string JwtKey = "integration-test-signing-key-definitely-long-enough-32chars!";

    private static (SeaweedFsPhotoStorage Storage, FakeSeaweedFsFiler Filer, ImageSigningService Signing)
        Build(string filerUrl = "http://seaweedfs-test:8333")
    {
        var filer = new FakeSeaweedFsFiler();
        var httpFactory = new SingleHandlerHttpClientFactory(filer.Handler);

        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Jwt:SigningKey"] = JwtKey,
                ["Images:SignatureValidityHours"] = "2",
            })
            .Build();

        var signing = new ImageSigningService(config);
        var options = Options.Create(new PhotoStorageOptions
        {
            FilerUrl = filerUrl,
        });
        var signer = new PhotoUrlSignerAdapter(signing);

        var storage = new SeaweedFsPhotoStorage(
            httpFactory,
            options,
            signer,
            NullLogger<SeaweedFsPhotoStorage>.Instance);

        return (storage, filer, signing);
    }

    // ── UploadAsync returns the raw path, not a URL ─────────────────

    [Fact]
    public async Task UploadAsync_Returns_Bare_Path_Under_Recipes_Prefix()
    {
        var (storage, _, _) = Build();
        using var ms = new MemoryStream(new byte[] { 1, 2, 3 });

        var path = await storage.UploadAsync(ms, "image/png", "photo.png");

        Assert.StartsWith("recipes/", path);
        Assert.EndsWith(".png", path);
        Assert.DoesNotContain("?", path);
        Assert.DoesNotContain("http", path);
    }

    [Fact]
    public async Task UploadAsync_Puts_Bytes_To_Filer_At_Same_Path()
    {
        var (storage, filer, _) = Build();
        var payload = new byte[] { 0xDE, 0xAD, 0xBE, 0xEF };
        using var ms = new MemoryStream(payload);

        var path = await storage.UploadAsync(ms, "image/jpeg", "photo.jpg");

        Assert.True(filer.Objects.TryGetValue(path, out var entry));
        Assert.Equal(payload, entry.Content);
        Assert.Equal("image/jpeg", entry.ContentType);
    }

    [Fact]
    public async Task UploadAsync_DerivesExtensionFromContentType()
    {
        var (storage, _, _) = Build();

        var jpgPath = await storage.UploadAsync(new MemoryStream(new byte[] { 1 }), "image/jpeg", "file");
        var pngPath = await storage.UploadAsync(new MemoryStream(new byte[] { 1 }), "image/png", "file");
        var webpPath = await storage.UploadAsync(new MemoryStream(new byte[] { 1 }), "image/webp", "file");

        Assert.EndsWith(".jpg", jpgPath);
        Assert.EndsWith(".png", pngPath);
        Assert.EndsWith(".webp", webpPath);
    }

    // ── GetPublicUrl produces a signed proxy URL ────────────────────

    [Fact]
    public async Task GetPublicUrl_Produces_Signed_Proxy_Url()
    {
        var (storage, _, signing) = Build();
        using var ms = new MemoryStream(new byte[] { 1 });
        var path = await storage.UploadAsync(ms, "image/png", "p.png");

        var url = storage.GetPublicUrl(path);

        Assert.StartsWith("/api/photos/" + path + "?sig=", url);
        Assert.Contains("&exp=", url);

        // And the produced signature must validate against the same signer.
        var query = url.Split('?')[1].Split('&');
        var sig = query[0].Split('=')[1];
        var exp = long.Parse(query[1].Split('=')[1], CultureInfo.InvariantCulture);
        Assert.True(signing.Validate(path, sig, exp));
    }

    // ── DeleteAsync accepts path OR signed URL ──────────────────────

    [Fact]
    public async Task DeleteAsync_Accepts_RawPath_And_Removes_From_Filer()
    {
        var (storage, filer, _) = Build();
        using var ms = new MemoryStream(new byte[] { 1 });
        var path = await storage.UploadAsync(ms, "image/png", "p.png");
        Assert.True(filer.Objects.ContainsKey(path));

        await storage.DeleteAsync(path);

        Assert.False(filer.Objects.ContainsKey(path));
    }

    [Fact]
    public async Task DeleteAsync_Accepts_Signed_Url_Strips_Query_And_ApiPrefix()
    {
        var (storage, filer, _) = Build();
        using var ms = new MemoryStream(new byte[] { 1 });
        var path = await storage.UploadAsync(ms, "image/png", "p.png");

        var signed = storage.GetPublicUrl(path);
        await storage.DeleteAsync(signed);

        Assert.False(filer.Objects.ContainsKey(path));
    }

    [Fact]
    public async Task DeleteAsync_Is_Idempotent_For_Unknown_Path()
    {
        var (storage, _, _) = Build();

        // Should not throw.
        await storage.DeleteAsync("recipes/nothing-here.png");
    }

    // ── Helpers ─────────────────────────────────────────────────────

    private sealed class SingleHandlerHttpClientFactory : IHttpClientFactory
    {
        private readonly HttpMessageHandler _handler;
        public SingleHandlerHttpClientFactory(HttpMessageHandler handler) => _handler = handler;
        public HttpClient CreateClient(string name) => new(_handler, disposeHandler: false);
    }

    private sealed class PhotoUrlSignerAdapter : IPhotoUrlSigner
    {
        private readonly ImageSigningService _signing;
        public PhotoUrlSignerAdapter(ImageSigningService signing) => _signing = signing;
        public string SignPhotoUrl(string path) => _signing.SignUrl($"/api/photos/{path}", path);
    }
}
