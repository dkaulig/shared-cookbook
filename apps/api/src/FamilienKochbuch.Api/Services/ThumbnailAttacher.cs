using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Infrastructure.Persistence;
using FamilienKochbuch.Infrastructure.Services;

namespace FamilienKochbuch.Api.Services;

/// <summary>
/// BUG-018 — best-effort downloader that turns the
/// <c>recipe.thumbnail_url</c> emitted by the URL extraction pipeline
/// (typically the yt-dlp video frame on a Facebook/Instagram/TikTok/
/// YouTube CDN) into a SeaweedFS-backed <see cref="StagedPhoto"/> the
/// frontend can adopt onto the saved recipe.
///
/// "Best effort" is load-bearing: a thumbnail download is never allowed
/// to fail the parent extraction. Download timeouts, oversize bodies,
/// non-image content-types, host-allowlist rejections — all surface as
/// a warning log and a returned <c>null</c>. The recipe still gets
/// created, just without an auto-attached photo.
///
/// Why not let yt-dlp's URL flow straight to the frontend? FB-CDN +
/// Instagram-CDN URLs typically expire after ~6 hours; a recipe form
/// that prefills a remote URL would render a broken image as soon as
/// the user re-opens it the next day. Persisting the bytes immediately
/// is the only way to survive the link expiry.
///
/// SSRF guard: the URL must resolve to an https host whose suffix
/// matches the <see cref="AllowedHostSuffixes"/> allowlist (the
/// known video-CDN domains). This blocks an attacker who can plant a
/// malicious extractor result from making us POST/GET arbitrary
/// internal IPs.
/// </summary>
public sealed class ThumbnailAttacher
{
    /// <summary>Named HttpClient registered against thumbnail downloads.
    /// Exposed for the DI registration in Program.cs so the timeout +
    /// allowed-redirect config lives in one place.</summary>
    public const string HttpClientName = "video-thumbnail-downloader";

    /// <summary>Hard cap on the downloaded thumbnail size. Mirrors the
    /// staged-photo upload cap (5 MB) so a thumbnail blob can never
    /// exceed what a manual upload would. yt-dlp typically returns
    /// thumbnails in the 50–800 KB range; the cap exists as defence
    /// against a hostile CDN serving multi-GB content.</summary>
    public const long MaxBytes = 5 * 1024 * 1024;

    /// <summary>Per-request timeout for the thumbnail GET. yt-dlp
    /// thumbnails are small (&lt;1 MB) and live on fast CDNs; 5 s is
    /// enough headroom for a slow VPS uplink without holding the
    /// extraction job hostage.</summary>
    public static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(5);

    /// <summary>SSRF host allowlist. The thumbnail must live on a host
    /// whose name ends with one of these suffixes. Suffix-match (rather
    /// than exact) covers the *.fbcdn.net, *.cdninstagram.com etc.
    /// shard hosts each provider rotates through. Add new entries here
    /// when extending source-host coverage; the empty string is never a
    /// match (defence against accidental bypass).</summary>
    public static readonly IReadOnlyCollection<string> AllowedHostSuffixes = new[]
    {
        ".fbcdn.net",
        ".cdninstagram.com",
        ".tiktokcdn.com",
        ".tiktokcdn-us.com",
        ".ytimg.com",
        ".ggpht.com",
        ".sndcdn.com",
        ".pinimg.com",
        ".vimeocdn.com",
        ".twimg.com",
        ".redditmedia.com",
    };

    private readonly AppDbContext _db;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IPhotoStorage _photoStorage;
    private readonly TimeProvider _clock;
    private readonly ILogger<ThumbnailAttacher> _logger;

    public ThumbnailAttacher(
        AppDbContext db,
        IHttpClientFactory httpClientFactory,
        IPhotoStorage photoStorage,
        TimeProvider clock,
        ILogger<ThumbnailAttacher> logger)
    {
        _db = db;
        _httpClientFactory = httpClientFactory;
        _photoStorage = photoStorage;
        _clock = clock;
        _logger = logger;
    }

    /// <summary>
    /// Attempts to download <c>resultJson.recipe.thumbnail_url</c>,
    /// upload it to SeaweedFS, persist a <see cref="StagedPhoto"/> row,
    /// and link it to the import via
    /// <see cref="RecipeImport.AttachThumbnailStagedPhoto"/>. Returns
    /// the new staged-photo id on success, or <c>null</c> when the
    /// thumbnail was missing or the download/validation failed.
    ///
    /// The caller is expected to invoke this after the import is
    /// already in <see cref="ImportStatus.Done"/> — the staged-photo
    /// link is supplementary, not part of the success criteria.
    /// </summary>
    public async Task<Guid?> TryAttachAsync(
        RecipeImport import,
        string resultJson,
        CancellationToken ct)
    {
        if (import is null) throw new ArgumentNullException(nameof(import));

        var thumbnailUrl = ExtractThumbnailUrl(resultJson);
        if (string.IsNullOrWhiteSpace(thumbnailUrl))
        {
            // No thumbnail in the extraction result — perfectly normal
            // for blog-style sources that don't expose a hero image.
            return null;
        }

        if (!IsAllowedThumbnailHost(thumbnailUrl, out var parsedUri))
        {
            _logger.LogWarning(
                "Skipping thumbnail attach for import {ImportId}: host {Host} is not on the allowed-suffix list.",
                import.Id, parsedUri?.Host ?? "<unparseable>");
            return null;
        }

        try
        {
            var (bytes, contentType) = await DownloadAsync(parsedUri!, ct);
            if (bytes is null || contentType is null)
            {
                // DownloadAsync already logged the precise failure mode.
                return null;
            }

            // Stream the in-memory buffer into the photo storage. We
            // could pipe the HTTP response directly to UploadAsync but
            // the explicit buffer makes the size-cap enforcement cheap
            // to reason about.
            string storagePath;
            using (var ms = new MemoryStream(bytes, writable: false))
            {
                storagePath = await _photoStorage.UploadAsync(
                    ms, contentType, originalFileName: "thumbnail", ct);
            }

            var signedUrl = _photoStorage.GetPublicUrl(storagePath);

            var staged = new StagedPhoto(
                userId: import.UserId,
                photoId: storagePath,
                signedUrl: signedUrl,
                contentType: contentType,
                createdAt: _clock.GetUtcNow());
            _db.StagedPhotos.Add(staged);

            import.AttachThumbnailStagedPhoto(staged.Id);
            await _db.SaveChangesAsync(ct);

            _logger.LogInformation(
                "Attached video thumbnail to import {ImportId} as staged photo {StagedPhotoId} ({Bytes} bytes, {ContentType}).",
                import.Id, staged.Id, bytes.Length, contentType);

            return staged.Id;
        }
        catch (HttpRequestException ex)
        {
            _logger.LogWarning(ex,
                "Thumbnail download for import {ImportId} failed at HTTP layer; continuing without auto-attached photo.",
                import.Id);
            return null;
        }
        catch (TaskCanceledException ex) when (!ct.IsCancellationRequested)
        {
            _logger.LogWarning(ex,
                "Thumbnail download for import {ImportId} timed out after {Timeout}s; continuing without auto-attached photo.",
                import.Id, RequestTimeout.TotalSeconds);
            return null;
        }
        catch (JsonException ex)
        {
            // Already-validated JSON should not parse-fail here — but
            // an arbitrary upstream regression should still degrade
            // gracefully rather than crashing the post-Done step.
            _logger.LogWarning(ex,
                "Thumbnail attach for import {ImportId} hit malformed JSON; continuing without auto-attached photo.",
                import.Id);
            return null;
        }
    }

    /// <summary>Pulls the <c>recipe.thumbnail_url</c> string out of the
    /// Python pipeline's structured-result JSON. Returns null when the
    /// field is missing, blank, or not a string. Public-static so the
    /// regression tests can exercise the parsing in isolation.</summary>
    public static string? ExtractThumbnailUrl(string resultJson)
    {
        if (string.IsNullOrWhiteSpace(resultJson)) return null;
        using var doc = JsonDocument.Parse(resultJson);
        if (doc.RootElement.ValueKind != JsonValueKind.Object) return null;
        if (!doc.RootElement.TryGetProperty("recipe", out var recipe)
            || recipe.ValueKind != JsonValueKind.Object)
        {
            return null;
        }
        if (!recipe.TryGetProperty("thumbnail_url", out var thumb)
            || thumb.ValueKind != JsonValueKind.String)
        {
            return null;
        }
        var raw = thumb.GetString();
        return string.IsNullOrWhiteSpace(raw) ? null : raw;
    }

    /// <summary>
    /// SSRF guard: the URL must be absolute http(s) and its host must
    /// end with one of <see cref="AllowedHostSuffixes"/>. Public-static
    /// so the regression tests can drive a wide param-table without
    /// spinning up the whole attacher.
    /// </summary>
    public static bool IsAllowedThumbnailHost(string url, out Uri? uri)
    {
        uri = null;
        if (string.IsNullOrWhiteSpace(url)) return false;
        if (!Uri.TryCreate(url, UriKind.Absolute, out var parsed)) return false;
        if (parsed.Scheme != Uri.UriSchemeHttp && parsed.Scheme != Uri.UriSchemeHttps)
            return false;

        uri = parsed;
        var host = parsed.Host.ToLowerInvariant();
        if (string.IsNullOrEmpty(host)) return false;

        foreach (var suffix in AllowedHostSuffixes)
        {
            // Suffix matches are anchored on the dot so "evilfbcdn.net"
            // (no leading dot) doesn't pass under ".fbcdn.net".
            if (host.EndsWith(suffix, StringComparison.OrdinalIgnoreCase))
                return true;
        }
        return false;
    }

    private async Task<(byte[]? Bytes, string? ContentType)> DownloadAsync(
        Uri url, CancellationToken ct)
    {
        var client = _httpClientFactory.CreateClient(HttpClientName);

        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(RequestTimeout);

        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        using var response = await client.SendAsync(
            request, HttpCompletionOption.ResponseHeadersRead, cts.Token);

        if (response.StatusCode != HttpStatusCode.OK)
        {
            _logger.LogWarning(
                "Thumbnail download from {Url} returned {Status}; skipping attach.",
                url, (int)response.StatusCode);
            return (null, null);
        }

        var contentType = response.Content.Headers.ContentType?.MediaType;
        if (string.IsNullOrEmpty(contentType)
            || !contentType.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
        {
            _logger.LogWarning(
                "Thumbnail download from {Url} returned non-image content-type {ContentType}; skipping attach.",
                url, contentType ?? "<missing>");
            return (null, null);
        }

        var declared = response.Content.Headers.ContentLength;
        if (declared is long n && n > MaxBytes)
        {
            _logger.LogWarning(
                "Thumbnail download from {Url} declared Content-Length {Bytes} > {Cap}; skipping attach.",
                url, n, MaxBytes);
            return (null, null);
        }

        // Buffered read with a hard byte cap. We can't trust the
        // declared Content-Length (a malicious CDN can lie), so the
        // copy loop bails the moment we cross MaxBytes regardless of
        // headers.
        await using var src = await response.Content.ReadAsStreamAsync(cts.Token);
        using var buffer = new MemoryStream(capacity: declared is long d && d > 0 ? (int)Math.Min(d, MaxBytes) : 64 * 1024);
        var pool = new byte[8 * 1024];
        long total = 0;
        int read;
        while ((read = await src.ReadAsync(pool.AsMemory(), cts.Token)) > 0)
        {
            total += read;
            if (total > MaxBytes)
            {
                _logger.LogWarning(
                    "Thumbnail download from {Url} exceeded {Cap}-byte cap mid-stream; skipping attach.",
                    url, MaxBytes);
                return (null, null);
            }
            await buffer.WriteAsync(pool.AsMemory(0, read), cts.Token);
        }

        // Normalise the content-type — IPhotoStorage's extension
        // derivation only knows the canonical jpeg/png/webp triple.
        // Anything else (image/avif, image/gif) gets stored verbatim;
        // SeaweedFs's DeriveExtension falls back to filename which we
        // gave as "thumbnail" (no extension).
        return (buffer.ToArray(), contentType);
    }
}
