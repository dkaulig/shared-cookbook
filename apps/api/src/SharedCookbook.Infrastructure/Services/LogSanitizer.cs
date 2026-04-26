namespace SharedCookbook.Infrastructure.Services;

/// <summary>
/// Strips ASCII control characters from user-influenceable strings before
/// they enter a log statement, mitigating CRLF / log-forging attacks where
/// an attacker injects <c>\n[FAKE]</c> into a request path or header to
/// fabricate adjacent log lines.
///
/// Triggered by SEC-1 — CodeQL <c>cs/log-forging</c> alerts on
/// <see cref="SharedCookbook.Api.Services.GlobalExceptionHandler"/> and
/// <see cref="SharedCookbook.Api.Services.InternalOnlyMiddleware"/>.
/// Serilog's JSON sink already escapes control chars, but plain-text
/// console / file sinks do not — so the sanitizer is defence in depth
/// for ops who tail logs in a terminal.
/// </summary>
public static class LogSanitizer
{
    /// <summary>
    /// Returns <paramref name="value"/> with carriage-return, line-feed,
    /// and tab replaced by underscores. <c>null</c> stays <c>null</c>.
    /// Empty stays empty. Strings without control chars are returned
    /// unchanged (no allocation when no replacement happened).
    /// </summary>
    public static string? ForLog(string? value)
    {
        if (string.IsNullOrEmpty(value)) return value;
        // Fast path: scan for any of \r \n \t before allocating.
        for (var i = 0; i < value.Length; i++)
        {
            var c = value[i];
            if (c == '\r' || c == '\n' || c == '\t')
            {
                // Slow path: build a fresh string with replacements.
                return value.Replace('\r', '_').Replace('\n', '_').Replace('\t', '_');
            }
        }
        return value;
    }
}
