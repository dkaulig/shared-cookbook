using System.Net;
using System.Net.Http.Headers;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace FamilienKochbuch.Infrastructure.Services;

/// <summary>
/// <see cref="IPhotoStorage"/> backed by the SeaweedFS <b>filer</b> REST
/// API over plain HTTP. No S3 SDK, no bucket concept, no payload signing
/// — just <c>PUT /{path}</c>, <c>DELETE /{path}</c>. Public URLs are
/// produced via <see cref="IPhotoUrlSigner"/> and served by the backend's
/// photo-proxy endpoint; SeaweedFS itself is never exposed to the
/// public network.
/// </summary>
public class SeaweedFsPhotoStorage : IPhotoStorage
{
    /// <summary>Path prefix on the filer for all recipe photo objects.</summary>
    public const string PathPrefix = "recipes";

    /// <summary>Public-facing proxy base path; stripped when parsing URLs
    /// that a client echoes back to <see cref="DeleteAsync"/>.</summary>
    public const string PublicApiPrefix = "/api/photos/";

    /// <summary>Named <see cref="IHttpClientFactory"/> client used for filer I/O.
    /// Kept in sync with the proxy-endpoint's client so both sides share a
    /// single HttpClient configuration point.</summary>
    public const string FilerHttpClientName = "seaweedfs-filer";

    private readonly IHttpClientFactory _httpFactory;
    private readonly IPhotoUrlSigner _signer;
    private readonly ILogger<SeaweedFsPhotoStorage> _logger;
    private readonly string _filerBaseUrl;

    public SeaweedFsPhotoStorage(
        IHttpClientFactory httpFactory,
        IOptions<PhotoStorageOptions> options,
        IPhotoUrlSigner signer,
        ILogger<SeaweedFsPhotoStorage> logger)
    {
        _httpFactory = httpFactory;
        _signer = signer;
        _logger = logger;
        _filerBaseUrl = options.Value.FilerUrl.TrimEnd('/');
    }

    public async Task<string> UploadAsync(
        Stream content,
        string contentType,
        string originalFileName,
        CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(content);
        if (string.IsNullOrWhiteSpace(contentType))
            throw new ArgumentException("Content type must not be blank.", nameof(contentType));

        var extension = DeriveExtension(contentType, originalFileName);
        var path = $"{PathPrefix}/{Guid.NewGuid():N}{extension}";

        var client = _httpFactory.CreateClient(FilerHttpClientName);
        using var payload = new StreamContent(content);
        payload.Headers.ContentType = new MediaTypeHeaderValue(contentType);

        var response = await client.PutAsync($"{_filerBaseUrl}/{path}", payload, ct);
        response.EnsureSuccessStatusCode();

        _logger.LogInformation(
            "Uploaded photo {Path} ({ContentType}) to SeaweedFS filer",
            path, contentType);

        return path;
    }

    public async Task DeleteAsync(string pathOrUrl, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(pathOrUrl))
            throw new ArgumentException("Path/URL must not be blank.", nameof(pathOrUrl));

        var path = NormalizeToPath(pathOrUrl);
        if (string.IsNullOrWhiteSpace(path))
        {
            _logger.LogWarning(
                "Cannot parse a storage path out of {Input}; skipping delete.",
                pathOrUrl);
            return;
        }

        var client = _httpFactory.CreateClient(FilerHttpClientName);
        try
        {
            var response = await client.DeleteAsync($"{_filerBaseUrl}/{path}", ct);
            if (response.StatusCode == HttpStatusCode.NotFound)
                return; // Idempotent — already gone.
            response.EnsureSuccessStatusCode();
            _logger.LogInformation("Deleted photo {Path} from SeaweedFS filer", path);
        }
        catch (HttpRequestException ex)
        {
            _logger.LogWarning(ex,
                "Failed to delete photo {Path} from SeaweedFS filer — continuing.", path);
        }
    }

    public string GetPublicUrl(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
            throw new ArgumentException("Path must not be blank.", nameof(path));

        var normalized = NormalizeToPath(path);
        return _signer.SignPhotoUrl(normalized);
    }

    /// <summary>
    /// PF1 — copy a blob from <paramref name="sourcePath"/> to
    /// <paramref name="destinationPath"/>.
    ///
    /// SeaweedFS's filer doesn't expose a server-side rename/move
    /// primitive in the version we use, so we GET the source bytes and
    /// PUT them at the destination. Bounded by the 5 MB staged-photo
    /// cap, which makes the round-trip acceptable in practice.
    /// TODO: switch to a native move once the filer ships one — the
    /// signature is intentionally future-proof.
    /// </summary>
    public async Task<string> CopyAsync(
        string sourcePath,
        string destinationPath,
        string contentType,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(sourcePath))
            throw new ArgumentException("Source path must not be blank.", nameof(sourcePath));
        if (string.IsNullOrWhiteSpace(destinationPath))
            throw new ArgumentException("Destination path must not be blank.", nameof(destinationPath));
        if (string.IsNullOrWhiteSpace(contentType))
            throw new ArgumentException("Content type must not be blank.", nameof(contentType));

        var src = NormalizeToPath(sourcePath);
        var dst = NormalizeToPath(destinationPath);

        var client = _httpFactory.CreateClient(FilerHttpClientName);

        using var getResponse = await client.GetAsync($"{_filerBaseUrl}/{src}", ct);
        getResponse.EnsureSuccessStatusCode();
        var bytes = await getResponse.Content.ReadAsByteArrayAsync(ct);

        if (bytes.LongLength > 5L * 1024 * 1024)
        {
            // Bounded by upstream validation, but emit a structured-log
            // warning if the policy ever drifts so we notice before the
            // copy chews up bandwidth.
            _logger.LogWarning(
                "PF1 photo copy from {Source} is {Size} bytes — above the 5 MB staged cap.",
                src, bytes.LongLength);
        }

        using var payload = new ByteArrayContent(bytes);
        payload.Headers.ContentType = new MediaTypeHeaderValue(contentType);

        var putResponse = await client.PutAsync($"{_filerBaseUrl}/{dst}", payload, ct);
        putResponse.EnsureSuccessStatusCode();

        _logger.LogInformation(
            "Copied photo {Source} -> {Destination} ({ContentType}) on SeaweedFS filer.",
            src, dst, contentType);

        return dst;
    }

    /// <summary>
    /// Parses a bare path out of a possibly URL-shaped input. Accepts:
    /// raw paths (<c>recipes/abc.png</c>), signed proxy URLs
    /// (<c>/api/photos/recipes/abc.png?sig=...&amp;exp=...</c>), and
    /// absolute URLs with the <c>/api/photos/</c> prefix.
    /// Returns the empty string when nothing recognizable is present.
    /// </summary>
    public static string NormalizeToPath(string input)
    {
        var trimmed = input.Trim();

        // Strip any query string.
        var qIdx = trimmed.IndexOf('?');
        if (qIdx >= 0) trimmed = trimmed[..qIdx];

        // Drop scheme + host if present.
        if (Uri.TryCreate(trimmed, UriKind.Absolute, out var abs))
            trimmed = abs.AbsolutePath;

        // Strip the /api/photos/ public prefix if we see it.
        if (trimmed.StartsWith(PublicApiPrefix, StringComparison.Ordinal))
            trimmed = trimmed[PublicApiPrefix.Length..];

        // Finally strip any leading slash.
        return trimmed.TrimStart('/');
    }

    private static string DeriveExtension(string contentType, string originalFileName)
    {
        var lowered = contentType.ToLowerInvariant();
        var ext = lowered switch
        {
            "image/jpeg" or "image/jpg" => ".jpg",
            "image/png" => ".png",
            "image/webp" => ".webp",
            _ => string.Empty,
        };

        if (ext.Length > 0) return ext;

        var fromName = Path.GetExtension(originalFileName);
        return string.IsNullOrWhiteSpace(fromName) ? string.Empty : fromName;
    }
}
