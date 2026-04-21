using System.Net;
using System.Net.Http.Headers;
using System.Net.Sockets;
using System.Text.Json;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Infrastructure.Persistence;
using FamilienKochbuch.Infrastructure.Services;

namespace FamilienKochbuch.Api.Services;

/// <summary>BUG-047 — resolver delegate that turns a hostname into the
/// set of IP addresses DNS would hand a socket. Pulled out to a named
/// delegate so tests can inject a deterministic resolver that returns
/// a public-looking IP for stubbed hosts without doing real DNS.</summary>
public delegate Task<IPAddress[]> ThumbnailHostResolver(
    string host, CancellationToken ct);

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

    /// <summary>CFG-3 — extractor-config key that gates this service.
    /// When the admin flips this flag to <c>false</c> in the admin UI,
    /// <see cref="TryAttachAsync"/> becomes a no-op that returns
    /// <c>null</c> before any HTTP fetch or DB write.</summary>
    public const string FeatureFlagKey = "feature.thumbnail_auto_attach_enabled";

    private readonly AppDbContext _db;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IPhotoStorage _photoStorage;
    private readonly TimeProvider _clock;
    private readonly ILogger<ThumbnailAttacher> _logger;
    private readonly ThumbnailHostResolver _resolveHost;
    private readonly IExtractorConfigReader _configReader;

    public ThumbnailAttacher(
        AppDbContext db,
        IHttpClientFactory httpClientFactory,
        IPhotoStorage photoStorage,
        TimeProvider clock,
        ILogger<ThumbnailAttacher> logger,
        IExtractorConfigReader configReader,
        ThumbnailHostResolver? resolveHost = null)
    {
        _db = db;
        _httpClientFactory = httpClientFactory;
        _photoStorage = photoStorage;
        _clock = clock;
        _logger = logger;
        _configReader = configReader;
        // Default to the framework's Dns resolver. The delegate
        // boundary exists so tests can avoid a real network call.
        _resolveHost = resolveHost ?? Dns.GetHostAddressesAsync;
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

        // CFG-3 — read-only kill switch. When an admin has flipped
        // feature.thumbnail_auto_attach_enabled = false in the admin
        // UI, short-circuit before any HTTP fetch / DB insert. The
        // parent import still completes (thumbnails are "best effort",
        // never load-bearing); we just don't auto-stage a photo.
        // Fallback default matches the seed (true) so a missing row on
        // a fresh DB behaves as "feature on".
        if (!await _configReader.GetFeatureFlagAsync(
                FeatureFlagKey, defaultValue: true, ct))
        {
            _logger.LogInformation(
                "Thumbnail attach skipped for import {ImportId} — feature disabled.",
                import.Id);
            return null;
        }

        var thumbnailUrl = ExtractThumbnailUrl(resultJson);
        if (string.IsNullOrWhiteSpace(thumbnailUrl))
        {
            // No thumbnail in the extraction result — perfectly normal
            // for blog-style sources that don't expose a hero image.
            return null;
        }

        if (!IsAllowedThumbnailHostForImport(thumbnailUrl, import.SourceUrl, out var parsedUri))
        {
            _logger.LogWarning(
                "Skipping thumbnail attach for import {ImportId}: host {Host} is not on the allowed-suffix list and does not share a registered domain with the import's source URL.",
                import.Id, parsedUri?.Host ?? "<unparseable>");
            return null;
        }

        // BUG-047 SSRF guard — the new same-origin branch trusts the
        // attacker-influenceable SourceUrl's registered domain. A hostile
        // blog could set up "internal.evil.com" → 192.168.x.x (or
        // 169.254.169.254 for AWS metadata) so the thumbnail GET hits
        // our internal network. Resolve the host and reject if any DNS
        // answer lands in a private / loopback / link-local / reserved
        // range. Mirrors the Python extractor's pre-fetch guard
        // (apps/python-extractor/src/extractor/pipeline/url.py).
        if (!await IsHostPublicAsync(parsedUri!.Host, ct))
        {
            _logger.LogWarning(
                "Skipping thumbnail attach for import {ImportId}: host {Host} resolved to a non-public address.",
                import.Id, parsedUri.Host);
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
                createdAt: _clock.GetUtcNow(),
                // BUG-048 — record the thumbnail URL on the staged row so
                // the reimport flow can dedupe on repeat runs without
                // refetching or making the recipe's Photos collection
                // load-bearing for the comparison.
                sourceUrl: thumbnailUrl);
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

    /// <summary>
    /// BUG-047 — host-acceptance predicate that extends
    /// <see cref="IsAllowedThumbnailHost"/> with a second, import-scoped
    /// rule: accept the thumbnail URL if it lives on the same
    /// registered domain (eTLD+1) as the import's <paramref name="sourceUrl"/>.
    ///
    /// Rationale: the Python extractor already SSRF-checked and fetched
    /// the source URL. A blog's own og:image on the same registered
    /// domain inherits that trust. Cross-origin thumbnails (e.g.
    /// attacker-controlled recipe URL pointing the image at someone
    /// else's host) remain rejected by falling back to the CDN-only
    /// allowlist behaviour.
    ///
    /// Registered-domain comparison uses a leftmost-label-strip
    /// approximation (masonfit.com vs cdn.masonfit.com → both become
    /// "masonfit.com" after strip → match). This isn't a full Public
    /// Suffix List implementation — it misses quirks like "bbc.co.uk"
    /// (where eTLD+1 is bbc.co.uk but the strip yields co.uk) — but
    /// the failure mode is conservative (we reject a legitimate sibling
    /// subdomain, we never accept a cross-origin attacker). Future work
    /// could bring in the PSL if a real case demands it.
    ///
    /// The http(s)-only and public-IP-resolution guards still apply
    /// downstream; this method only answers "is this host acceptable
    /// in principle?"
    /// </summary>
    public static bool IsAllowedThumbnailHostForImport(
        string url, string? sourceUrl, out Uri? uri)
    {
        // CDN allowlist always wins: FB/IG/TikTok/etc. CDN thumbnails
        // are accepted irrespective of SourceUrl, because the attacher
        // was originally built for the yt-dlp path where there's no
        // matching source host.
        if (IsAllowedThumbnailHost(url, out uri)) return true;

        // Not on the CDN allowlist — only acceptable if the import has
        // a SourceUrl AND the thumbnail shares that URL's registered
        // domain.
        if (uri is null) return false;
        if (string.IsNullOrWhiteSpace(sourceUrl)) return false;
        if (!Uri.TryCreate(sourceUrl, UriKind.Absolute, out var sourceUri))
            return false;
        if (sourceUri.Scheme != Uri.UriSchemeHttp
            && sourceUri.Scheme != Uri.UriSchemeHttps)
        {
            return false;
        }

        return SharesRegisteredDomain(uri.Host, sourceUri.Host);
    }

    /// <summary>
    /// Leftmost-label-strip approximation of "same eTLD+1":
    /// <c>a.example.com</c> and <c>b.example.com</c> both reduce to
    /// <c>example.com</c>; <c>example.com</c> itself reduces to
    /// <c>com</c>. Two hosts share a registered domain when their
    /// reductions match AND contain at least one dot (so the match
    /// isn't a bare TLD like "com"). Case-insensitive per DNS rules.
    ///
    /// Simplification tradeoff documented on
    /// <see cref="IsAllowedThumbnailHostForImport"/>.
    /// </summary>
    private static bool SharesRegisteredDomain(string host, string sourceHost)
    {
        if (string.IsNullOrEmpty(host) || string.IsNullOrEmpty(sourceHost))
            return false;

        var left = host.ToLowerInvariant();
        var right = sourceHost.ToLowerInvariant();

        // Both hosts must have at least one dot — reject bare single
        // labels ("localhost", raw IPs parsed as hosts, etc.). This
        // also implicitly blocks sourceUrl hosts that look like IPv4
        // literals with no dots (impossible, but defensive).
        if (!left.Contains('.') || !right.Contains('.')) return false;

        // Exact host match — trivially the same registered domain.
        if (string.Equals(left, right, StringComparison.Ordinal)) return true;

        // Otherwise strip the leftmost label from each side and
        // require the remainders to match AND still contain a dot.
        // The dot requirement prevents "a.com" vs "b.com" → both strip
        // to "com" → bare-TLD collision → must not match.
        var leftStripped = StripLeftmostLabel(left);
        var rightStripped = StripLeftmostLabel(right);
        if (!leftStripped.Contains('.') || !rightStripped.Contains('.'))
            return false;

        return string.Equals(leftStripped, rightStripped, StringComparison.Ordinal);
    }

    private static string StripLeftmostLabel(string host)
    {
        var dot = host.IndexOf('.');
        return dot < 0 ? host : host[(dot + 1)..];
    }

    /// <summary>
    /// Resolves <paramref name="host"/> via the injected resolver and
    /// checks that every returned IP sits in a globally-routable range.
    /// Any private / loopback / link-local / multicast / unspecified /
    /// IPv4-mapped IPv6 / unique-local-IPv6 answer fails the whole
    /// check — a hostile DNS record with multiple A answers can't slip
    /// one internal address past us by mixing it with a public one.
    ///
    /// Returns <c>false</c> on DNS failure; we'd rather skip the
    /// thumbnail than chance fetching it against an unknown resolver
    /// state.
    /// </summary>
    private async Task<bool> IsHostPublicAsync(string host, CancellationToken ct)
    {
        IPAddress[] addrs;
        try
        {
            addrs = await _resolveHost(host, ct);
        }
        catch (SocketException)
        {
            return false;
        }
        catch (ArgumentException)
        {
            return false;
        }

        if (addrs.Length == 0) return false;

        foreach (var addr in addrs)
        {
            if (!IsPublicAddress(addr)) return false;
        }
        return true;
    }

    /// <summary>
    /// Public-address predicate. Blocks the obvious IPv4 private
    /// ranges (10/8, 172.16/12, 192.168/16), loopback (127/8),
    /// link-local (169.254/16, also AWS metadata 169.254.169.254),
    /// IPv4 broadcast, and the IPv6 analogues: ::1 loopback,
    /// fe80::/10 link-local, fc00::/7 unique-local, and any
    /// IPv4-mapped IPv6 that wraps a private v4 address.
    /// </summary>
    internal static bool IsPublicAddress(IPAddress addr)
    {
        if (IPAddress.IsLoopback(addr)) return false;

        if (addr.AddressFamily == AddressFamily.InterNetwork)
        {
            var bytes = addr.GetAddressBytes();
            // 10.0.0.0/8
            if (bytes[0] == 10) return false;
            // 172.16.0.0/12
            if (bytes[0] == 172 && (bytes[1] & 0xF0) == 16) return false;
            // 192.168.0.0/16
            if (bytes[0] == 192 && bytes[1] == 168) return false;
            // 169.254.0.0/16 link-local (includes AWS metadata
            // 169.254.169.254)
            if (bytes[0] == 169 && bytes[1] == 254) return false;
            // 0.0.0.0/8 unspecified / current-network
            if (bytes[0] == 0) return false;
            // 127.0.0.0/8 covered by IsLoopback above
            // 100.64.0.0/10 CGNAT
            if (bytes[0] == 100 && (bytes[1] & 0xC0) == 64) return false;
            // 224.0.0.0/4 multicast
            if ((bytes[0] & 0xF0) == 224) return false;
            // 240.0.0.0/4 reserved + 255.255.255.255 broadcast
            if ((bytes[0] & 0xF0) == 240) return false;
            return true;
        }

        if (addr.AddressFamily == AddressFamily.InterNetworkV6)
        {
            if (addr.IsIPv6LinkLocal) return false;
            if (addr.IsIPv6SiteLocal) return false;
            if (addr.IsIPv6Multicast) return false;
            // Unique local fc00::/7 — first byte 0xFC or 0xFD.
            var b = addr.GetAddressBytes();
            if ((b[0] & 0xFE) == 0xFC) return false;
            // ::/128 unspecified
            if (addr.Equals(IPAddress.IPv6None)) return false;
            // IPv4-mapped IPv6 — unwrap and recurse.
            if (addr.IsIPv4MappedToIPv6)
            {
                return IsPublicAddress(addr.MapToIPv4());
            }
            return true;
        }

        // Unknown address family — play safe.
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
