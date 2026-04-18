using System.Collections.Concurrent;
using FamilienKochbuch.Infrastructure.Services;

namespace FamilienKochbuch.Api.Tests.Infrastructure;

/// <summary>
/// In-memory <see cref="IPhotoStorage"/> for integration tests. Stores the
/// byte payload per path so assertions can round-trip; emits deterministic
/// signed-shape URLs from <see cref="GetPublicUrl"/> without touching the
/// real signing service. Matches the new post-migration contract:
/// <see cref="UploadAsync"/> returns the bare path, <see cref="DeleteAsync"/>
/// accepts either a path or a signed URL.
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
        var path = $"{SeaweedFsPhotoStorage.PathPrefix}/{Guid.NewGuid():N}{extension}";
        Uploads[path] = (bytes, contentType);
        return path;
    }

    public Task DeleteAsync(string pathOrUrl, CancellationToken ct = default)
    {
        var path = SeaweedFsPhotoStorage.NormalizeToPath(pathOrUrl);
        Uploads.TryRemove(path, out _);
        Deleted.Add(path);
        return Task.CompletedTask;
    }

    /// <summary>Produces a deterministic, signature-shaped URL so tests can assert
    /// that endpoints run their output through <see cref="GetPublicUrl"/>.
    /// The values are fixed (not a real HMAC) because the fake is
    /// intentionally decoupled from <c>ImageSigningService</c>.</summary>
    public string GetPublicUrl(string path)
    {
        var normalized = SeaweedFsPhotoStorage.NormalizeToPath(path);
        return $"/api/photos/{normalized}?sig=fake-sig&exp=9999999999";
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
