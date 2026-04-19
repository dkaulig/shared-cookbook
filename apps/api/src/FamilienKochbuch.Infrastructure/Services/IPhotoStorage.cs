namespace FamilienKochbuch.Infrastructure.Services;

/// <summary>
/// Abstraction over the object store that backs recipe photos. The
/// production impl (<see cref="SeaweedFsPhotoStorage"/>) PUTs to SeaweedFS's
/// filer over plain HTTP; integration tests use an in-memory fake.
///
/// Stored value in the domain is the bare <b>path</b> returned by
/// <see cref="UploadAsync"/>. The public-facing URL is always computed
/// fresh at response-time via <see cref="GetPublicUrl"/> so each URL
/// carries a current expiry.
/// </summary>
public interface IPhotoStorage
{
    /// <summary>Uploads the stream. Returns the <b>raw path</b> (not a URL)
    /// for storage in the domain. Implementations should validate size /
    /// content-type upstream — this contract only guarantees persistence.</summary>
    Task<string> UploadAsync(
        Stream content,
        string contentType,
        string originalFileName,
        CancellationToken ct = default);

    /// <summary>Deletes the object identified by <paramref name="pathOrUrl"/>.
    /// Accepts either the bare path previously returned from
    /// <see cref="UploadAsync"/> or a signed proxy URL (the implementation
    /// strips the <c>/api/photos/</c> prefix and any query string).
    /// Idempotent — silently succeeds when the object is already gone.</summary>
    Task DeleteAsync(string pathOrUrl, CancellationToken ct = default);

    /// <summary>Returns a freshly-signed public URL for the given storage path.
    /// Signed URLs are never persisted — they are recomputed on every
    /// response so the expiry window is always relative to "now".</summary>
    string GetPublicUrl(string path);

    /// <summary>
    /// PF1 — copy a blob from one storage path to another. Used by the
    /// create-recipe promote flow to migrate a staged photo into the
    /// recipe's namespace without round-tripping through the
    /// disk-to-disk path on the API host. Returns the destination path
    /// (canonicalised in the same way as <see cref="UploadAsync"/>).
    ///
    /// The naive default implementation is download + upload; SeaweedFS
    /// can do better via a server-side hint (TODO: native move when the
    /// filer exposes one — for now, download + upload is acceptable
    /// because the staged blobs are bounded at 5 MB).
    /// </summary>
    Task<string> CopyAsync(
        string sourcePath,
        string destinationPath,
        string contentType,
        CancellationToken ct = default);
}
