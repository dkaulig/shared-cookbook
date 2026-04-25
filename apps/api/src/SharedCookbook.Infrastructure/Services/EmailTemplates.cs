namespace SharedCookbook.Infrastructure.Services;

/// <summary>
/// Plain-text German templates for the three PF3 transactional mails.
/// Centralised here so future HTML polish (deferred to Phase 3) has one
/// stop. Placeholders are substituted via <c>string.Replace</c> — no
/// Razor, no Jinja, just strings.
///
/// Security + style rules:
/// - Bodies are UTF-8 plain text.
/// - Lines are short (roughly &lt;= 70 chars) so clients that hard-wrap
///   don't mangle the reading experience.
/// - No tracking pixels, no unsubscribe links (transactional mail).
/// </summary>
internal static class EmailTemplates
{
    // ── Password reset ──────────────────────────────────────────────

    public const string PasswordResetSubject = "Passwort zurücksetzen — Familien-Kochbuch";

    public static string PasswordResetBody(string displayName, string resetUrl) => $"""
        Hallo {displayName},

        du hast eine Passwort-Zurücksetzung für dein Familien-Kochbuch-Konto
        angefordert. Folge diesem Link (gültig 24 Stunden), um ein neues
        Passwort zu vergeben:

        {resetUrl}

        Solltest du diese Anfrage nicht gestellt haben, ignoriere diese
        E-Mail einfach — dein aktuelles Passwort bleibt unverändert.

        — Familien-Kochbuch
        """;

    // ── App invite ──────────────────────────────────────────────────

    public const string AppInviteSubject = "Einladung zum Familien-Kochbuch";

    public static string AppInviteBody(string inviterDisplayName, string acceptUrl, string? personalNote)
    {
        var notePart = string.IsNullOrWhiteSpace(personalNote)
            ? string.Empty
            : $"\nPersönliche Nachricht von {inviterDisplayName}:\n  {personalNote}\n";

        return $"""
            Hallo,

            {inviterDisplayName} hat dich ins Familien-Kochbuch eingeladen
            — eine private Sammlung für Familien- und Freundes-Rezepte.
            {notePart}
            Lege dein Konto hier an:

            {acceptUrl}

            Der Link ist 14 Tage gültig.

            — Familien-Kochbuch
            """;
    }

    // ── Group invite ────────────────────────────────────────────────

    public static string GroupInviteSubject(string groupName) =>
        $"Einladung zur Gruppe \"{groupName}\" — Familien-Kochbuch";

    public static string GroupInviteBody(string inviterDisplayName, string groupName, string acceptUrl) => $"""
        Hallo,

        {inviterDisplayName} hat dich in die Gruppe "{groupName}" im
        Familien-Kochbuch eingeladen. Ab sofort kannst du die Rezepte der
        Gruppe sehen und neue beitragen.

        Einladung ansehen:

        {acceptUrl}

        — Familien-Kochbuch
        """;
}
