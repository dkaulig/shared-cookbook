namespace FamilienKochbuch.Api.Services;

/// <summary>
/// LANG-1 — central <c>Accept-Language</c> parser. The whitelist matches
/// the Python extractor's <c>normalize_accept_language</c> helper and the
/// REL-3h fallback chain on the web side: anything outside <c>de | en</c>
/// collapses to <c>"en"</c>.
///
/// Used twice on the inbound request path:
/// <list type="number">
/// <item>The import enqueue endpoints persist the result on
/// <see cref="Domain.Entities.RecipeImport.RequestedLanguage"/> so the
/// Hangfire job — which runs hours later, after a possible retry — can
/// forward the same language to Python regardless of whether the
/// browser is still online.</item>
/// <item>Sync proxy paths (<c>/chat/.../to-recipe</c>) read the header
/// directly and pipe it through to Python without storage.</item>
/// </list>
///
/// The parser is deliberately tolerant: empty / garbage / unsupported
/// headers fall back to the default rather than throwing, because the
/// caller is the browser, not a programmatic client we want to crash on.
/// </summary>
public static class LanguageNormalizer
{
    /// <summary>Default fallback language. Matches the REL-3h fallback
    /// (<c>en</c>) so a browser reporting an unsupported locale gets the
    /// project's English copy.</summary>
    public const string DefaultLanguage = "en";

    /// <summary>The two whitelisted languages today. LANG-4 (FR / IT /
    /// ES) will widen this set; everything else stays the same.</summary>
    private static readonly HashSet<string> Supported =
        new(StringComparer.OrdinalIgnoreCase) { "de", "en" };

    /// <summary>
    /// Parse the first preference of an <c>Accept-Language</c> header
    /// into one of the two whitelisted language codes.
    ///
    /// Behaviour:
    /// <list type="bullet">
    /// <item>Empty / null / whitespace → <see cref="DefaultLanguage"/>.</item>
    /// <item>First language tag wins; quality-weights (<c>;q=…</c>) are
    /// ignored. Browsers already order by preference in practice.</item>
    /// <item>Region suffix is stripped (<c>de-DE</c> → <c>de</c>),
    /// case-insensitive.</item>
    /// <item>Unsupported / malformed values fall back to
    /// <see cref="DefaultLanguage"/>.</item>
    /// </list>
    /// </summary>
    public static string Normalise(string? header)
    {
        if (string.IsNullOrWhiteSpace(header))
            return DefaultLanguage;

        // First language preference — substring before the first comma.
        var firstComma = header.IndexOf(',');
        var first = firstComma >= 0 ? header[..firstComma] : header;

        // Drop quality-weights / extension parameters.
        var firstSemicolon = first.IndexOf(';');
        if (firstSemicolon >= 0)
            first = first[..firstSemicolon];

        first = first.Trim();
        if (first.Length == 0) return DefaultLanguage;

        // Strip region suffix. Hyphen is the standard subtag separator;
        // underscore appears in some legacy locales.
        var dash = first.IndexOf('-');
        if (dash >= 0) first = first[..dash];
        var underscore = first.IndexOf('_');
        if (underscore >= 0) first = first[..underscore];

        var normalised = first.Trim().ToLowerInvariant();
        return Supported.Contains(normalised) ? normalised : DefaultLanguage;
    }
}
