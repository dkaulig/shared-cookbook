using System.Collections.Concurrent;
using FamilienKochbuch.Infrastructure.Services;

namespace FamilienKochbuch.Api.Tests.Infrastructure;

/// <summary>
/// In-memory <see cref="IPhotoStorage"/> for integration tests. Stores the
/// byte payload per URL so assertions can round-trip. Returns
/// <c>fake://&lt;guid&gt;.&lt;ext&gt;</c> URLs that survive upload → DB →
/// JSON-response serialization without any SeaweedFS container.
/// </summary>
public class FakePhotoStorage : IPhotoStorage
{
    public ConcurrentDictionary<string, (byte[] Content, string ContentType)> Uploads { get; } = new();
    public ConcurrentBag<string> Deleted { get; } = new();

    public async Task<string> UploadAsync(
        Stream content,
        string contentType,
        string originalFileName,
        CancellationToken ct = default)
    {
        using var ms = new MemoryStream();
        await content.CopyToAsync(ms, ct);
        var bytes = ms.ToArray();

        var extension = contentType.ToLowerInvariant() switch
        {
            "image/jpeg" or "image/jpg" => ".jpg",
            "image/png" => ".png",
            "image/webp" => ".webp",
            _ => Path.GetExtension(originalFileName),
        };
        var url = $"fake://{Guid.NewGuid():N}{extension}";
        Uploads[url] = (bytes, contentType);
        return url;
    }

    public Task DeleteAsync(string url, CancellationToken ct = default)
    {
        Uploads.TryRemove(url, out _);
        Deleted.Add(url);
        return Task.CompletedTask;
    }

    public void Clear()
    {
        Uploads.Clear();
#if NET9_0_OR_GREATER
        Deleted.Clear();
#else
        while (Deleted.TryTake(out _)) { }
#endif
    }
}
