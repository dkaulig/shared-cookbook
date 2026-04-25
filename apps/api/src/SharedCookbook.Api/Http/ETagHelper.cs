using System.Globalization;
using SharedCookbook.Api.Services;
using SharedCookbook.Domain.Common;
using Microsoft.AspNetCore.Http;

namespace SharedCookbook.Api.Http;

/// <summary>
/// OFF3 weak-ETag helpers used on the mutation + entity-GET endpoints.
/// </summary>
public static class ETagHelper
{
    /// <summary>
    /// Builds a weak ETag <c>W/"&lt;id&gt;-&lt;version&gt;"</c>. Weak
    /// semantics because serialised DTOs with the same (id, version)
    /// can still differ by unstable ordering (e.g. tag order); the
    /// browser / workbox cache only needs to answer "did the entity
    /// change" — byte-identical responses are not required.
    /// </summary>
    public static string Compute(Guid id, int version) =>
        $"W/\"{id:D}-{version.ToString(CultureInfo.InvariantCulture)}\"";

    /// <summary>
    /// Parses an <c>If-Match</c> header value. Accepts both the strong
    /// form (<c>"&lt;id&gt;-&lt;v&gt;"</c>) and the weak form
    /// (<c>W/"&lt;id&gt;-&lt;v&gt;"</c>). Returns <c>null</c> on any
    /// parse failure — the caller treats <c>null</c> as "no concurrency
    /// check requested" so pre-OFF3 clients keep working untouched.
    /// Empty or missing header → <c>null</c>. A literal <c>*</c> is
    /// rejected (our ETags are always specific id-version pairs).
    /// </summary>
    public static (Guid Id, int Version)? TryParse(string? ifMatch)
    {
        if (string.IsNullOrWhiteSpace(ifMatch)) return null;

        var raw = ifMatch.Trim();
        // Wildcard match is meaningless for our tokens.
        if (raw == "*") return null;

        // Strip the optional weak prefix.
        if (raw.StartsWith("W/", StringComparison.Ordinal))
            raw = raw[2..].TrimStart();

        // Require a quoted payload.
        if (raw.Length < 2 || raw[0] != '"' || raw[^1] != '"') return null;
        var payload = raw[1..^1];

        // Version is the suffix after the LAST dash — the GUID itself
        // contains four dashes, so IndexOf('-') would split mid-id.
        var dash = payload.LastIndexOf('-');
        if (dash <= 0 || dash == payload.Length - 1) return null;

        var idPart = payload[..dash];
        var versionPart = payload[(dash + 1)..];

        if (!Guid.TryParseExact(idPart, "D", out var id)) return null;
        // NumberStyles.None rejects leading sign / whitespace / exponent.
        if (!int.TryParse(versionPart, NumberStyles.None, CultureInfo.InvariantCulture, out var version))
            return null;
        if (version < 0) return null;

        return (id, version);
    }

    /// <summary>
    /// Wraps an <see cref="IResult"/> so the response carries an ETag
    /// header matching the supplied (id, version) tuple. Encapsulates
    /// the <see cref="IResult.ExecuteAsync"/> indirection Minimal APIs
    /// need to set response headers post-hoc.
    /// </summary>
    public static IResult WithETag(IResult inner, Guid id, int version) =>
        new ETagResult(inner, Compute(id, version));

    /// <summary>
    /// Shortcut for the common pattern <c>WithETag(Results.Ok(dto), …)</c>.
    /// </summary>
    public static IResult Ok(object? dto, Guid id, int version) =>
        WithETag(Results.Ok(dto), id, version);

    /// <summary>
    /// Pulls the <c>If-Match</c> header off an incoming request and
    /// validates it against the supplied <paramref name="entity"/>.
    /// Returns <c>null</c> when the check passes (or no header was
    /// supplied — backward-compat path). When the check fails, returns
    /// a 409 Conflict <see cref="IResult"/> whose body carries the
    /// supplied <paramref name="current"/> projection so the frontend
    /// can render the conflict UI without an extra round-trip.
    /// </summary>
    public static IResult? RequireMatchingVersion<T>(
        HttpRequest request,
        T entity,
        Func<Guid> idSelector,
        object? current = null)
        where T : class, IVersionedEntity
    {
        if (request.Headers.TryGetValue("If-Match", out var raw) == false)
            return null;

        var parsed = TryParse(raw.ToString());
        if (parsed is null) return null;

        var (expectedId, expectedVersion) = parsed.Value;
        var actualId = idSelector();
        if (expectedId == actualId && expectedVersion == entity.Version)
            return null;

        return FamilienResults.Conflict(
            ErrorCodes.VersionMismatch,
            "Version mismatch; reload and retry.",
            current);
    }

    /// <summary>
    /// Adds browser-cache hints to an entity GET response. Sets the
    /// <c>Cache-Control</c> header to <c>private, max-age=0</c> so
    /// intermediary caches don't hold the payload while still allowing
    /// the browser to issue a conditional GET (<c>If-None-Match</c>)
    /// on the next request. The <c>ETag</c> header is added by the
    /// wrapped <see cref="ETagResult"/>.
    /// </summary>
    private const string DefaultCacheControl = "private, max-age=0";

    /// <summary>
    /// <see cref="IResult"/> decorator that sets ETag + Cache-Control
    /// headers on the outgoing response before delegating to the inner
    /// result. Minimal APIs don't expose a simple "add header" helper
    /// so we thread through <see cref="IResult.ExecuteAsync"/>.
    /// </summary>
    private sealed class ETagResult : IResult
    {
        private readonly IResult _inner;
        private readonly string _etag;

        public ETagResult(IResult inner, string etag)
        {
            _inner = inner;
            _etag = etag;
        }

        public Task ExecuteAsync(HttpContext httpContext)
        {
            var headers = httpContext.Response.Headers;
            headers["ETag"] = _etag;
            // Cache-Control is set alongside so the browser can cache
            // conditionally; revalidation is mandatory because max-age=0.
            // If the endpoint already set a different Cache-Control
            // (e.g. for a short-lived image proxy) leave it alone —
            // the ETag is the only header OFF3 strictly requires here.
            if (!headers.ContainsKey("Cache-Control"))
                headers["Cache-Control"] = DefaultCacheControl;
            return _inner.ExecuteAsync(httpContext);
        }
    }
}
