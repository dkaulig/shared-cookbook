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
    public async Task UploadAsync_Stores_Bytes_And_Returns_Fake_Url()
    {
        var storage = new FakePhotoStorage();
        var bytes = Encoding.UTF8.GetBytes("fake-png-bytes");
        using var ms = new MemoryStream(bytes);

        var url = await storage.UploadAsync(ms, "image/png", "photo.png");

        Assert.StartsWith("fake://", url);
        Assert.EndsWith(".png", url);
        Assert.True(storage.Uploads.TryGetValue(url, out var entry));
        Assert.Equal(bytes, entry.Content);
        Assert.Equal("image/png", entry.ContentType);
    }

    [Fact]
    public async Task UploadAsync_Returns_Distinct_Urls_For_Multiple_Uploads()
    {
        var storage = new FakePhotoStorage();
        using var ms1 = new MemoryStream(new byte[] { 1 });
        using var ms2 = new MemoryStream(new byte[] { 2 });

        var url1 = await storage.UploadAsync(ms1, "image/jpeg", "a.jpg");
        var url2 = await storage.UploadAsync(ms2, "image/jpeg", "b.jpg");

        Assert.NotEqual(url1, url2);
    }

    [Fact]
    public async Task DeleteAsync_Removes_Upload_And_Records_Url()
    {
        var storage = new FakePhotoStorage();
        using var ms = new MemoryStream(new byte[] { 1, 2, 3 });
        var url = await storage.UploadAsync(ms, "image/png", "photo.png");

        await storage.DeleteAsync(url);

        Assert.False(storage.Uploads.ContainsKey(url));
        Assert.Contains(url, storage.Deleted);
    }

    [Fact]
    public async Task DeleteAsync_Is_Idempotent()
    {
        var storage = new FakePhotoStorage();

        await storage.DeleteAsync("fake://nothing.png");

        Assert.Single(storage.Deleted);
    }
}
