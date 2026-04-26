namespace SharedCookbook.Infrastructure.Services;

/// <summary>
/// Masks email addresses for log output. Keeps the first character (or two,
/// for longer locals) of the local-part visible plus the full domain so a
/// human reader can match a log line to a known user without the full PII.
///
/// Triggered by SEC-1 — CodeQL <c>cs/exposure-of-sensitive-information</c>
/// alerts on <see cref="SeedDataService"/>, <see cref="NoOpEmailSender"/>,
/// and <see cref="SmtpEmailSender"/>. Defense in depth: even though the
/// API logs are server-side, anything that ends up forwarded to Sentry /
/// Datadog / a `docker logs` paste in a chat now leaks one initial + the
/// domain rather than the entire address.
/// </summary>
public static class EmailMasking
{
    /// <summary>
    /// Returns a masked form of <paramref name="email"/> safe for log output.
    /// Examples: <c>j***@example.com</c>, <c>jo***@example.com</c>,
    /// <c>a***@b.de</c>. Inputs without an <c>@</c> or empty inputs are
    /// returned unchanged — they are not email addresses, callers' problem.
    /// </summary>
    public static string Mask(string? email)
    {
        if (string.IsNullOrEmpty(email)) return email ?? string.Empty;
        var atIdx = email.IndexOf('@');
        if (atIdx <= 0) return email;
        var local = email[..atIdx];
        var domain = email[(atIdx + 1)..];
        var visible = local.Length <= 3 ? 1 : 2;
        return $"{local[..visible]}***@{domain}";
    }
}
