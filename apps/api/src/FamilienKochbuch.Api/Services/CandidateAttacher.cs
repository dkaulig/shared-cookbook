using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Infrastructure.Persistence;
using FamilienKochbuch.Infrastructure.Services;

namespace FamilienKochbuch.Api.Services;

/// <summary>COVER-0 — resolver delegate that turns a hostname into the
/// set of IP addresses DNS would hand a socket. Mirrors the
/// <c>ThumbnailHostResolver</c> shape so tests can inject a deterministic
/// resolver; renamed to reflect the multi-candidate shape.</summary>
public delegate Task<IPAddress[]> CandidateHostResolver(
    string host, CancellationToken ct);

/// <summary>
/// COVER-0 — replaces the single-URL <c>ThumbnailAttacher</c>. Downloads
/// up to N candidate thumbnails the Python extractor emitted
/// (<c>recipe.candidate_thumbnails</c>), persists one
/// <see cref="StagedPhoto"/> per success, and returns the ids ordered by
/// the caller-supplied <c>CandidateOrder</c>. Each download is best-effort:
/// SSRF allowlist rejection, oversize body, non-image MIME, timeout, or
/// a non-200 response all surface as a warning log and a skipped entry —
/// the parent extraction never fails because a candidate download did.
///
/// <para>Ordering semantics: the returned array preserves caller-supplied
/// ordering (= index in the original URL list), but gaps are allowed when
/// some downloads fail. A mixed-outcome import where URLs[0] + URLs[2]
/// succeed but URLs[1] fails produces two staged-photo rows with
/// <c>CandidateOrder = 0</c> and <c>CandidateOrder = 2</c>; the returned
/// <see cref="Guid"/>[] has length 2. Gaps in the persisted
/// <c>CandidateOrder</c> column are the source of truth for the
/// frontend's grid renderer, which only renders tiles for successfully-
/// downloaded candidates.</para>
///
/// <para>SSRF posture matches today's <c>ThumbnailAttacher</c>: the URL
/// host must either (a) end in one of <see cref="AllowedHostSuffixes"/>
/// or (b) share a registered domain with an optional <c>sourceUrl</c>
/// (BUG-047 same-origin branch, kept identical for blog-import parity).
/// After allowlist acceptance the host is resolved and every returned IP
/// must be globally routable — a hostile DNS record that mixes a public
/// address with 192.168.x.x or 169.254.169.254 fails the whole check.</para>
///
/// <para>Parallelism: <see cref="MaxDegreeOfParallelism"/> concurrent
/// downloads (default 3) so a malicious extractor result that emits 6
/// URLs at a single CDN doesn't burst a connection storm. The frontend
/// UX tolerates a sequential slowdown (1-3 s extra per candidate) more
/// gracefully than a 429 from a rate-limited CDN.</para>
/// </summary>
public sealed class CandidateAttacher
{
    /// <summary>Named HttpClient registered against candidate downloads.
    /// Exposed for the DI registration in Program.cs so the timeout +
    /// redirect config lives in one place.</summary>
    public const string HttpClientName = "candidate-downloader";

    /// <summary>Per-URL byte cap. Mirrors the staged-photo upload cap
    /// (5 MB) so a candidate blob can never exceed what a manual upload
    /// would. yt-dlp thumbnails + ffmpeg frames typically sit in the
    /// 50-800 KB range; the cap exists as defence against a hostile CDN
    /// serving multi-GB content.</summary>
    public const long MaxBytesPerCandidate = 5 * 1024 * 1024;

    /// <summary>Per-request timeout. 5 s is enough headroom for a slow
    /// VPS uplink against the major video CDNs without holding the
    /// extraction job hostage on a dead URL.</summary>
    public static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(5);

    /// <summary>Cap on concurrent candidate downloads. 3 keeps a single
    /// CDN from receiving a synchronous 6-deep burst while still letting
    /// most imports finish the candidate stage in under 5 s.</summary>
    public const int MaxDegreeOfParallelism = 3;

    /// <summary>SSRF host allowlist — shared with the old
    /// <c>ThumbnailAttacher</c>. New entries go here when adding support
    /// for a new video CDN; suffix match is anchored on the dot so
    /// "evilfbcdn.net" (no leading dot) doesn't pass under ".fbcdn.net".</summary>
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

    /// <summary>CFG-3 kill-switch key. Admin flips this to <c>false</c>
    /// in the admin UI to short-circuit every candidate attach without a
    /// deploy. Defaults to <c>true</c> (seed behaviour) when missing.</summary>
    public const string FeatureFlagKey = "feature.thumbnail_auto_attach_enabled";

    private readonly AppDbContext _db;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IPhotoStorage _photoStorage;
    private readonly TimeProvider _clock;
    private readonly ILogger<CandidateAttacher> _logger;
    private readonly CandidateHostResolver _resolveHost;
    private readonly IExtractorConfigReader _configReader;
    private readonly HashSet<string> _allowedInternalHosts;

    /// <summary>COVER-0 fix — hostnames that skip the CDN suffix allowlist
    /// + public-IP DNS gate. Populated from configuration at DI time so
    /// ops can add / remove docker-internal services without a code
    /// change. Exact-match only (case-insensitive). See
    /// <see cref="IsInternalHost"/>.
    ///
    /// <para>Rationale: the python-extractor serves ffmpeg-extracted
    /// video frames from its own <c>/extractor/frames</c> endpoint. The
    /// hostname is <c>python-extractor</c> (docker-compose service name)
    /// and DNS resolves to the compose network's private 172.28.x.x
    /// range. The CDN allowlist doesn't match, and the public-IP gate
    /// rejects private addresses — both would fail. Rather than weaken
    /// the general rules, we carve out an exact-hostname allowlist
    /// populated from configuration.</para>
    /// </summary>
    public IReadOnlyCollection<string> AllowedInternalHosts => _allowedInternalHosts;

    public CandidateAttacher(
        AppDbContext db,
        IHttpClientFactory httpClientFactory,
        IPhotoStorage photoStorage,
        TimeProvider clock,
        ILogger<CandidateAttacher> logger,
        IExtractorConfigReader configReader,
        CandidateHostResolver? resolveHost = null,
        IEnumerable<string>? allowedInternalHosts = null)
    {
        _db = db;
        _httpClientFactory = httpClientFactory;
        _photoStorage = photoStorage;
        _clock = clock;
        _logger = logger;
        _configReader = configReader;
        _resolveHost = resolveHost ?? Dns.GetHostAddressesAsync;
        _allowedInternalHosts = new HashSet<string>(
            (allowedInternalHosts ?? Array.Empty<string>())
                .Where(h => !string.IsNullOrWhiteSpace(h))
                .Select(h => h.Trim().ToLowerInvariant()),
            StringComparer.Ordinal);
    }

    /// <summary>Exact-match predicate for the internal-hosts carve-out.
    /// Case-insensitive on host, scheme gate stays at the caller
    /// (<see cref="DownloadOneAsync"/> insists on http/https before
    /// consulting this).</summary>
    private bool IsInternalHost(string host)
        => _allowedInternalHosts.Contains(host.ToLowerInvariant());

    /// <summary>
    /// Downloads the <paramref name="candidateUrls"/> in parallel (bounded
    /// by <see cref="MaxDegreeOfParallelism"/>), persists one
    /// <see cref="StagedPhoto"/> per success with
    /// <c>LinkedImportId = importId</c> and
    /// <c>CandidateOrder = index-in-input-list</c>, and returns the
    /// successful staged-photo ids ordered by <c>CandidateOrder</c>.
    ///
    /// Empty / null input → empty array, no DB touch. A hit on the CFG-3
    /// kill-switch → empty array, no network I/O. Per-URL failures never
    /// throw; they log + get skipped.
    /// </summary>
    public async Task<Guid[]> DownloadAndStageAsync(
        Guid userId,
        Guid importId,
        IReadOnlyList<string> candidateUrls,
        string? sourceUrl,
        CancellationToken ct)
    {
        if (userId == Guid.Empty)
            throw new ArgumentException("UserId must not be empty.", nameof(userId));
        if (importId == Guid.Empty)
            throw new ArgumentException("ImportId must not be empty.", nameof(importId));

        if (candidateUrls is null || candidateUrls.Count == 0)
            return Array.Empty<Guid>();

        // CFG-3 kill-switch shared with the legacy ThumbnailAttacher —
        // one admin toggle disables the whole candidate pipeline without
        // a deploy. Early-return keeps the import itself succeeding.
        if (!await _configReader.GetFeatureFlagAsync(
                FeatureFlagKey, defaultValue: true, ct))
        {
            _logger.LogInformation(
                "Candidate attach skipped for import {ImportId} — feature disabled.",
                importId);
            return Array.Empty<Guid>();
        }

        // Download in parallel — bounded by MaxDegreeOfParallelism so a
        // 6-URL import can't burst a rate-limited CDN. Each successful
        // download produces a (order, bytes, contentType, url) tuple the
        // post-loop block materialises into a StagedPhoto row.
        var results = new ConcurrentBag<DownloadResult>();
        using var gate = new SemaphoreSlim(MaxDegreeOfParallelism, MaxDegreeOfParallelism);
        var tasks = candidateUrls
            .Select((url, idx) => DownloadOneAsync(gate, importId, idx, url, sourceUrl, results, ct))
            .ToArray();
        await Task.WhenAll(tasks);

        if (results.IsEmpty) return Array.Empty<Guid>();

        // Deterministic order: the caller's ordering survives, gaps and
        // all. The StagedPhoto rows are inserted in this order so a
        // tracking-friendly EF save walks them linearly.
        var ordered = results.OrderBy(r => r.Order).ToList();
        var stagedIds = new List<Guid>(ordered.Count);
        foreach (var r in ordered)
        {
            string storagePath;
            using (var ms = new MemoryStream(r.Bytes, writable: false))
            {
                storagePath = await _photoStorage.UploadAsync(
                    ms, r.ContentType, originalFileName: "candidate", ct);
            }

            var signedUrl = _photoStorage.GetPublicUrl(storagePath);
            var staged = new StagedPhoto(
                userId: userId,
                photoId: storagePath,
                signedUrl: signedUrl,
                contentType: r.ContentType,
                createdAt: _clock.GetUtcNow(),
                sourceUrl: r.Url,
                linkedImportId: importId,
                candidateOrder: r.Order);
            _db.StagedPhotos.Add(staged);
            stagedIds.Add(staged.Id);
        }
        await _db.SaveChangesAsync(ct);

        _logger.LogInformation(
            "Candidate attach for import {ImportId}: {Success}/{Total} URLs staged.",
            importId, stagedIds.Count, candidateUrls.Count);

        return stagedIds.ToArray();
    }

    private async Task DownloadOneAsync(
        SemaphoreSlim gate,
        Guid importId,
        int order,
        string url,
        string? sourceUrl,
        ConcurrentBag<DownloadResult> results,
        CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            // COVER-0 fix — the python-extractor serves ffmpeg frames
            // via its own HTTP endpoint on the docker-internal network.
            // An exact-hostname match against AllowedInternalHosts (+ an
            // http/https scheme gate) lets those fetches pass the
            // downloader's SSRF gauntlet. The public-IP + CDN checks
            // stay active for every other URL.
            if (TryParseHttpUri(url, out var internalUri)
                && IsInternalHost(internalUri!.Host))
            {
                var (internalBytes, internalContentType) =
                    await DownloadAsync(internalUri, ct);
                if (internalBytes is null || internalContentType is null) return;
                results.Add(new DownloadResult(
                    order, url, internalBytes, internalContentType));
                return;
            }

            // SSRF allowlist / same-origin check fires BEFORE DNS + HTTP
            // so a hostile URL on a disallowed host never reaches the
            // socket layer. Matches the ThumbnailAttacher posture.
            if (!IsAllowedHostForImport(url, sourceUrl, out var parsedUri))
            {
                _logger.LogWarning(
                    "Skipping candidate {Order} for import {ImportId}: host {Host} is not on the allowed-suffix list and does not share a registered domain with the source URL.",
                    order, importId, parsedUri?.Host ?? "<unparseable>");
                return;
            }

            // Public-IP guard — reject a hostile DNS record even when the
            // registered-domain check accepted the host.
            if (!await IsHostPublicAsync(parsedUri!.Host, ct))
            {
                _logger.LogWarning(
                    "Skipping candidate {Order} for import {ImportId}: host {Host} resolved to a non-public address.",
                    order, importId, parsedUri.Host);
                return;
            }

            var (bytes, contentType) = await DownloadAsync(parsedUri!, ct);
            if (bytes is null || contentType is null) return; // already logged

            results.Add(new DownloadResult(order, url, bytes, contentType));
        }
        catch (HttpRequestException ex)
        {
            _logger.LogWarning(ex,
                "Candidate {Order} download for import {ImportId} failed at HTTP layer; skipping.",
                order, importId);
        }
        catch (TaskCanceledException ex) when (!ct.IsCancellationRequested)
        {
            _logger.LogWarning(ex,
                "Candidate {Order} download for import {ImportId} timed out after {Timeout}s; skipping.",
                order, importId, RequestTimeout.TotalSeconds);
        }
        finally
        {
            gate.Release();
        }
    }

    private readonly record struct DownloadResult(
        int Order, string Url, byte[] Bytes, string ContentType);

    /// <summary>Parse-and-scheme-gate a candidate URL. Returns
    /// <c>true</c> only when the URL is absolute + http/https. Used by
    /// the internal-host carve-out so a <c>file://</c> / <c>ftp://</c>
    /// URL can never reach the fetcher even if its host portion
    /// happens to match an entry in
    /// <see cref="AllowedInternalHosts"/>.</summary>
    private static bool TryParseHttpUri(string url, out Uri? uri)
    {
        uri = null;
        if (string.IsNullOrWhiteSpace(url)) return false;
        if (!Uri.TryCreate(url, UriKind.Absolute, out var parsed)) return false;
        if (parsed.Scheme != Uri.UriSchemeHttp && parsed.Scheme != Uri.UriSchemeHttps)
            return false;
        uri = parsed;
        return true;
    }

    /// <summary>Pure allowlist / same-origin acceptance check. Kept
    /// <c>public static</c> so the regression tests can drive a parameter
    /// table without spinning up the full attacher. The CDN allowlist
    /// always wins; otherwise the URL is accepted when it shares an
    /// eTLD+1 (leftmost-label-strip approximation) with
    /// <paramref name="sourceUrl"/>.
    /// </summary>
    public static bool IsAllowedHostForImport(
        string url, string? sourceUrl, out Uri? uri)
    {
        uri = null;
        if (string.IsNullOrWhiteSpace(url)) return false;
        if (!Uri.TryCreate(url, UriKind.Absolute, out var parsed)) return false;
        if (parsed.Scheme != Uri.UriSchemeHttp && parsed.Scheme != Uri.UriSchemeHttps)
            return false;

        uri = parsed;
        var host = parsed.Host.ToLowerInvariant();
        if (string.IsNullOrEmpty(host)) return false;

        // CDN allowlist — suffix match anchored on the dot so
        // "evilfbcdn.net" (no leading dot) doesn't slip past ".fbcdn.net".
        foreach (var suffix in AllowedHostSuffixes)
        {
            if (host.EndsWith(suffix, StringComparison.OrdinalIgnoreCase))
                return true;
        }

        // Same-origin branch: the Python extractor already SSRF-checked
        // and fetched the source URL; a thumbnail on the same registered
        // domain inherits that trust.
        if (string.IsNullOrWhiteSpace(sourceUrl)) return false;
        if (!Uri.TryCreate(sourceUrl, UriKind.Absolute, out var sourceUri))
            return false;
        if (sourceUri.Scheme != Uri.UriSchemeHttp
            && sourceUri.Scheme != Uri.UriSchemeHttps)
        {
            return false;
        }

        return SharesRegisteredDomain(host, sourceUri.Host);
    }

    private static bool SharesRegisteredDomain(string host, string sourceHost)
    {
        if (string.IsNullOrEmpty(host) || string.IsNullOrEmpty(sourceHost))
            return false;

        var left = host.ToLowerInvariant();
        var right = sourceHost.ToLowerInvariant();

        if (!left.Contains('.') || !right.Contains('.')) return false;
        if (string.Equals(left, right, StringComparison.Ordinal)) return true;

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

    private async Task<bool> IsHostPublicAsync(string host, CancellationToken ct)
    {
        IPAddress[] addrs;
        try
        {
            addrs = await _resolveHost(host, ct);
        }
        catch (SocketException) { return false; }
        catch (ArgumentException) { return false; }

        if (addrs.Length == 0) return false;
        foreach (var addr in addrs)
        {
            if (!IsPublicAddress(addr)) return false;
        }
        return true;
    }

    /// <summary>Public-IP predicate — identical to the old
    /// <c>ThumbnailAttacher.IsPublicAddress</c>. Blocks the IPv4 private
    /// ranges, loopback, link-local (incl. AWS metadata 169.254.169.254),
    /// CGNAT, multicast, broadcast, and the IPv6 analogues (loopback ::1,
    /// link-local fe80::/10, unique-local fc00::/7) plus IPv4-mapped
    /// IPv6 that wraps a private v4 address.</summary>
    internal static bool IsPublicAddress(IPAddress addr)
    {
        if (IPAddress.IsLoopback(addr)) return false;

        if (addr.AddressFamily == AddressFamily.InterNetwork)
        {
            var bytes = addr.GetAddressBytes();
            if (bytes[0] == 10) return false;
            if (bytes[0] == 172 && (bytes[1] & 0xF0) == 16) return false;
            if (bytes[0] == 192 && bytes[1] == 168) return false;
            if (bytes[0] == 169 && bytes[1] == 254) return false;
            if (bytes[0] == 0) return false;
            if (bytes[0] == 100 && (bytes[1] & 0xC0) == 64) return false;
            if ((bytes[0] & 0xF0) == 224) return false;
            if ((bytes[0] & 0xF0) == 240) return false;
            return true;
        }

        if (addr.AddressFamily == AddressFamily.InterNetworkV6)
        {
            if (addr.IsIPv6LinkLocal) return false;
            if (addr.IsIPv6SiteLocal) return false;
            if (addr.IsIPv6Multicast) return false;
            var b = addr.GetAddressBytes();
            if ((b[0] & 0xFE) == 0xFC) return false;
            if (addr.Equals(IPAddress.IPv6None)) return false;
            if (addr.IsIPv4MappedToIPv6)
            {
                return IsPublicAddress(addr.MapToIPv4());
            }
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
                "Candidate download from {Url} returned {Status}; skipping.",
                url, (int)response.StatusCode);
            return (null, null);
        }

        var contentType = response.Content.Headers.ContentType?.MediaType;
        if (string.IsNullOrEmpty(contentType)
            || !contentType.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
        {
            _logger.LogWarning(
                "Candidate download from {Url} returned non-image content-type {ContentType}; skipping.",
                url, contentType ?? "<missing>");
            return (null, null);
        }

        var declared = response.Content.Headers.ContentLength;
        if (declared is long n && n > MaxBytesPerCandidate)
        {
            _logger.LogWarning(
                "Candidate download from {Url} declared Content-Length {Bytes} > {Cap}; skipping.",
                url, n, MaxBytesPerCandidate);
            return (null, null);
        }

        await using var src = await response.Content.ReadAsStreamAsync(cts.Token);
        using var buffer = new MemoryStream(
            capacity: declared is long d && d > 0
                ? (int)Math.Min(d, MaxBytesPerCandidate)
                : 64 * 1024);
        var pool = new byte[8 * 1024];
        long total = 0;
        int read;
        while ((read = await src.ReadAsync(pool.AsMemory(), cts.Token)) > 0)
        {
            total += read;
            if (total > MaxBytesPerCandidate)
            {
                _logger.LogWarning(
                    "Candidate download from {Url} exceeded {Cap}-byte cap mid-stream; skipping.",
                    url, MaxBytesPerCandidate);
                return (null, null);
            }
            await buffer.WriteAsync(pool.AsMemory(0, read), cts.Token);
        }

        return (buffer.ToArray(), contentType);
    }
}
