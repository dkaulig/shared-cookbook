using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;

namespace SharedCookbook.Api.Services;

/// <summary>
/// BUG-013 — canonicalises user-supplied recipe URLs for import-cache
/// equality checks. Two URLs that differ only by tracking-parameter
/// noise (<c>?fbclid=…</c>, <c>?utm_source=…</c>, <c>?mibextid=…</c>)
/// or by the host's casing must collapse to the same canonical string
/// so the pre-enqueue cache-lookup in
/// <c>ImportEndpoints.EnqueueUrlImportAsync</c> actually hits when the
/// user re-pastes a link from a different share source.
///
/// Rules:
/// <list type="bullet">
/// <item>Scheme + host are lower-cased.</item>
/// <item>Tracking-only query parameters are stripped
///     (<see cref="StrippedQueryParameterNames"/> exact matches plus
///     the <c>utm_*</c> prefix).</item>
/// <item>Surviving query parameters retain their original order.</item>
/// <item>Default ports are dropped; explicit non-default ports kept.</item>
/// <item>Fragments are preserved (may encode SPA routing a YouTube
///     timestamp for instance).</item>
/// <item>A trailing slash on the path is left untouched so
///     <c>/rezept/</c> and <c>/rezept</c> stay distinct — the server
///     does not redirect between them and overriding that here would be
///     guess-work.</item>
/// </list>
///
/// The helper intentionally does not catch invalid URIs — the caller is
/// <c>EnqueueUrlImportAsync</c> which has already validated the URL
/// shape via <c>TryNormalizeHttpUrl</c> before invoking us. If a
/// malformed URL ever reaches this code we let the
/// <see cref="UriFormatException"/> propagate so the bug surfaces
/// instead of silently caching unrelated entries.
/// </summary>
public static class UrlNormaliser
{
    /// <summary>
    /// Exact-match tracking parameters stripped from the query string.
    /// Case-insensitive (Facebook sometimes ships <c>FBclid</c>).
    /// </summary>
    public static readonly IReadOnlyCollection<string> StrippedQueryParameterNames =
        new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "fbclid",
            "gclid",
            "mibextid",
            "_ga",
            "ref_src",
            "ref_url",
            "igshid",
            "si",           // YouTube share id
            "feature",      // YouTube feature-source tag
        };

    /// <summary>
    /// Any query parameter whose name starts with one of these prefixes
    /// (case-insensitive) is stripped. <c>utm_*</c> covers the full
    /// Google Analytics UTM suite (<c>utm_source</c>, <c>utm_medium</c>,
    /// <c>utm_campaign</c>, <c>utm_term</c>, <c>utm_content</c>, plus
    /// the vendor-specific <c>utm_id</c>/<c>utm_cid</c> variants).
    /// </summary>
    public static readonly IReadOnlyCollection<string> StrippedQueryParameterPrefixes =
        new[] { "utm_" };

    /// <summary>
    /// Normalises the supplied absolute http(s) URL into its canonical
    /// cache-key form. See the type-level remarks for the exact ruleset.
    /// </summary>
    /// <exception cref="UriFormatException">
    /// Thrown when <paramref name="raw"/> is not a parseable absolute URI.
    /// </exception>
    /// <exception cref="ArgumentException">
    /// Thrown when <paramref name="raw"/> is null / whitespace-only.
    /// </exception>
    public static string Normalise(string raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
            throw new ArgumentException("URL must not be empty.", nameof(raw));

        var uri = new Uri(raw.Trim(), UriKind.Absolute);

        var scheme = uri.Scheme.ToLowerInvariant();
        var host = uri.Host.ToLowerInvariant();

        var builder = new UriBuilder
        {
            Scheme = scheme,
            Host = host,
            Path = uri.AbsolutePath,
            Fragment = uri.Fragment.TrimStart('#'),
        };

        // UriBuilder.Port = -1 suppresses the port — do that for defaults
        // so the canonical form drops :80 / :443.
        if (uri.IsDefaultPort)
        {
            builder.Port = -1;
        }
        else
        {
            builder.Port = uri.Port;
        }

        builder.Query = FilterQuery(uri.Query);
        return builder.Uri.ToString();
    }

    /// <summary>
    /// Returns the surviving query string (without the leading '?')
    /// after tracking parameters are removed. Preserves the original
    /// key ordering and the original percent-encoding of values.
    /// </summary>
    private static string FilterQuery(string rawQuery)
    {
        if (string.IsNullOrEmpty(rawQuery)) return string.Empty;

        // Strip the leading '?' if present — Uri.Query includes it.
        var q = rawQuery.StartsWith('?') ? rawQuery[1..] : rawQuery;
        if (q.Length == 0) return string.Empty;

        var kept = new List<string>();
        foreach (var part in q.Split('&'))
        {
            if (part.Length == 0) continue;
            var eq = part.IndexOf('=');
            var key = eq < 0 ? part : part[..eq];
            if (ShouldStripKey(key)) continue;
            kept.Add(part);
        }
        if (kept.Count == 0) return string.Empty;
        return string.Join('&', kept);
    }

    private static bool ShouldStripKey(string rawKey)
    {
        if (string.IsNullOrEmpty(rawKey)) return false;
        // Values arrive percent-encoded; keys are ASCII in practice,
        // but decode to be safe so an encoded "utm_source" would still
        // match.
        var key = Uri.UnescapeDataString(rawKey);
        if (StrippedQueryParameterNames.Contains(key)) return true;
        foreach (var prefix in StrippedQueryParameterPrefixes)
        {
            if (key.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                return true;
        }
        return false;
    }
}
