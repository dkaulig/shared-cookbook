namespace FamilienKochbuch.Infrastructure.Services;

/// <summary>
/// Abstraction over the object store that backs recipe photos. The
/// production impl (<see cref="SeaweedFsPhotoStorage"/>) pushes to SeaweedFS
/// via the S3-compatible gateway; tests use a byte-array fake so integration
/// tests don't require a live SeaweedFS container.
/// </summary>
public interface IPhotoStorage
{
    /// <summary>Uploads the stream, returning the public URL. Implementations
    /// should validate size/content-type upstream — this contract only
    /// guarantees persistence.</summary>
    Task<string> UploadAsync(
        Stream content,
        string contentType,
        string originalFileName,
        CancellationToken ct = default);

    /// <summary>Deletes the object referenced by <paramref name="url"/>. Idempotent —
    /// silently succeeds when the object is already gone.</summary>
    Task DeleteAsync(string url, CancellationToken ct = default);
}
