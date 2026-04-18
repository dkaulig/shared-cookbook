using System.Text;
using Xunit;

namespace FamilienKochbuch.Api.Tests.Infrastructure;

/// <summary>
/// Contract tests for <see cref="FakePhotoStorage"/> — the in-memory fake
/// used by API integration tests in place of SeaweedFS. Keeps the fake's
/// behaviour honest (round-trip upload → URL → retrieve → delete).
/// </summary>
public class FakePhotoStorageTests
{
    [Fact]
    public async Task UploadAsync_Stores_Bytes_And_Returns_Bare_Path()
    {
        var storage = new FakePhotoStorage();
        var bytes = Encoding.UTF8.GetBytes("fake-png-bytes");
        using var ms = new MemoryStream(bytes);

        var path = await storage.UploadAsync(ms, "image/png", "photo.png");

        // New contract: UploadAsync returns the raw path (no URL, no query).
        Assert.StartsWith("recipes/", path);
        Assert.EndsWith(".png", path);
        Assert.DoesNotContain("?", path);
        Assert.DoesNotContain("http", path);
        Assert.True(storage.Uploads.TryGetValue(path, out var entry));
        Assert.Equal(bytes, entry.Content);
        Assert.Equal("image/png", entry.ContentType);
    }

    [Fact]
    public async Task UploadAsync_Returns_Distinct_Paths_For_Multiple_Uploads()
    {
        var storage = new FakePhotoStorage();
        using var ms1 = new MemoryStream(new byte[] { 1 });
        using var ms2 = new MemoryStream(new byte[] { 2 });

        var p1 = await storage.UploadAsync(ms1, "image/jpeg", "a.jpg");
        var p2 = await storage.UploadAsync(ms2, "image/jpeg", "b.jpg");

        Assert.NotEqual(p1, p2);
    }

    [Fact]
    public async Task GetPublicUrl_Produces_Deterministic_Signed_Url_Shape()
    {
        var storage = new FakePhotoStorage();

        var url = storage.GetPublicUrl("recipes/abcd.png");

        Assert.StartsWith("/api/photos/recipes/abcd.png", url);
        Assert.Contains("?sig=", url);
        Assert.Contains("&exp=", url);
    }

    [Fact]
    public async Task DeleteAsync_Accepts_Raw_Path_Removes_Upload_And_Records()
    {
        var storage = new FakePhotoStorage();
        using var ms = new MemoryStream(new byte[] { 1, 2, 3 });
        var path = await storage.UploadAsync(ms, "image/png", "photo.png");

        await storage.DeleteAsync(path);

        Assert.False(storage.Uploads.ContainsKey(path));
        Assert.Contains(path, storage.Deleted);
    }

    [Fact]
    public async Task DeleteAsync_Accepts_Signed_Url_And_Normalizes_To_Path()
    {
        var storage = new FakePhotoStorage();
        using var ms = new MemoryStream(new byte[] { 1, 2, 3 });
        var path = await storage.UploadAsync(ms, "image/png", "photo.png");

        var signed = storage.GetPublicUrl(path);
        await storage.DeleteAsync(signed);

        Assert.False(storage.Uploads.ContainsKey(path));
        Assert.Contains(path, storage.Deleted);
    }

    [Fact]
    public async Task DeleteAsync_Is_Idempotent()
    {
        var storage = new FakePhotoStorage();

        await storage.DeleteAsync("recipes/nothing.png");

        Assert.Single(storage.Deleted);
    }
}
