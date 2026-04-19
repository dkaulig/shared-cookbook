using MailKit.Net.Smtp;
using MailKit.Security;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using MimeKit;

namespace FamilienKochbuch.Infrastructure.Services;

/// <summary>
/// Real SMTP-backed <see cref="IEmailSender"/>. Uses MailKit's
/// <see cref="MailKit.Net.Smtp.SmtpClient"/> with one connection per send
/// (no pool for v1 — throughput is tiny for a family-cookbook app). Plain
/// text UTF-8 bodies; HTML polish is deferred to Phase 3.
///
/// On any failure the sender raises <see cref="EmailSendException"/>.
/// Callers MUST catch + log and continue — password-reset / invite-create
/// endpoints are authoritative on the domain record regardless of mail
/// delivery.
/// </summary>
public sealed class SmtpEmailSender : IEmailSender
{
    private const int SmtpTimeoutMs = 30_000;

    /// <summary>Resolves the configured options so test-only overrides
    /// (e.g. pointing at a localhost fake) flow through.</summary>
    private readonly Func<SmtpOptionsSnapshot> _optionsFactory;
    private readonly ILogger<SmtpEmailSender> _logger;

    /// <summary>Prod constructor: binds to the Api's Options type through
    /// the Infrastructure seam (see <see cref="ISmtpOptionsAccessor"/>).</summary>
    public SmtpEmailSender(ISmtpOptionsAccessor options, ILogger<SmtpEmailSender> logger)
    {
        _optionsFactory = () => options.Current;
        _logger = logger;
    }

    /// <summary>Test constructor: lets the netDumbster-backed suite inject
    /// a <see cref="SmtpOptionsSnapshot"/> pointed at a local fake.</summary>
    internal SmtpEmailSender(SmtpOptionsSnapshot snapshot, ILogger<SmtpEmailSender> logger)
    {
        _optionsFactory = () => snapshot;
        _logger = logger;
    }

    public Task SendPasswordResetAsync(
        string toEmail,
        string displayName,
        string resetUrl,
        CancellationToken ct = default)
    {
        var subject = "Passwort zurücksetzen — Familien-Kochbuch";
        var body = BuildPasswordResetBody(displayName, resetUrl);
        return SendAsync(toEmail, subject, body, ct);
    }

    public Task SendAppInviteAsync(
        string toEmail,
        string inviterDisplayName,
        string acceptUrl,
        string? personalNote,
        CancellationToken ct = default)
    {
        var subject = "Einladung zum Familien-Kochbuch";
        var body = BuildAppInviteBody(inviterDisplayName, acceptUrl, personalNote);
        return SendAsync(toEmail, subject, body, ct);
    }

    public Task SendGroupInviteAsync(
        string toEmail,
        string inviterDisplayName,
        string groupName,
        string acceptUrl,
        CancellationToken ct = default)
    {
        var subject = $"Einladung zur Gruppe \"{groupName}\" — Familien-Kochbuch";
        var body = BuildGroupInviteBody(inviterDisplayName, groupName, acceptUrl);
        return SendAsync(toEmail, subject, body, ct);
    }

    // ── Internals ───────────────────────────────────────────────────

    private async Task SendAsync(string toEmail, string subject, string body, CancellationToken ct)
    {
        var opts = _optionsFactory();

        var message = new MimeMessage();
        message.From.Add(new MailboxAddress(opts.FromName, opts.FromAddress));
        message.To.Add(MailboxAddress.Parse(toEmail));
        message.Subject = subject;
        message.Body = new TextPart("plain") { Text = body };

        using var client = new SmtpClient { Timeout = SmtpTimeoutMs };
        try
        {
            // StartTls when enabled (prod); plain-text otherwise (test fakes
            // like netDumbster don't speak TLS, and a dev developer running
            // a local Mailpit will also speak plaintext).
            var socketOption = opts.UseStartTls
                ? SecureSocketOptions.StartTls
                : SecureSocketOptions.None;

            await client.ConnectAsync(opts.Host, opts.Port, socketOption, ct);

            if (!string.IsNullOrEmpty(opts.User))
                await client.AuthenticateAsync(opts.User, opts.Password, ct);

            await client.SendAsync(message, ct);
            await client.DisconnectAsync(quit: true, ct);

            // Subject + recipient only — never body content.
            _logger.LogInformation(
                "Sent email: subject={Subject} to={Recipient}",
                subject, toEmail);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(
                ex,
                "SMTP send failed: subject={Subject} to={Recipient}",
                subject, toEmail);
            throw new EmailSendException(
                $"Failed to send email to {toEmail}: {ex.Message}", ex);
        }
    }

    private static string BuildPasswordResetBody(string displayName, string resetUrl) => $"""
        Hallo {displayName},

        du hast eine Passwort-Zurücksetzung für dein Familien-Kochbuch-Konto
        angefordert. Folge diesem Link (gültig 24 Stunden), um ein neues
        Passwort zu vergeben:

        {resetUrl}

        Solltest du diese Anfrage nicht gestellt haben, ignoriere diese
        E-Mail einfach — dein aktuelles Passwort bleibt unverändert.

        — Familien-Kochbuch
        """;

    private static string BuildAppInviteBody(string inviterDisplayName, string acceptUrl, string? personalNote)
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

    private static string BuildGroupInviteBody(string inviterDisplayName, string groupName, string acceptUrl) => $"""
        Hallo,

        {inviterDisplayName} hat dich in die Gruppe "{groupName}" im
        Familien-Kochbuch eingeladen. Ab sofort kannst du die Rezepte der
        Gruppe sehen und neue beitragen.

        Einladung ansehen:

        {acceptUrl}

        — Familien-Kochbuch
        """;
}

/// <summary>Immutable snapshot of the SMTP settings consumed by one send
/// operation. Kept separate from the Api-layer <c>SmtpOptions</c> class
/// so the Infrastructure project does not take a dependency on the Api
/// project. The Api wires the two together via <see cref="ISmtpOptionsAccessor"/>.</summary>
public sealed record SmtpOptionsSnapshot(
    string Host,
    int Port,
    string User,
    string Password,
    string FromAddress,
    string FromName,
    bool UseStartTls);

/// <summary>Seam so <see cref="SmtpEmailSender"/> can read the bound
/// <c>SmtpOptions</c> without taking a direct dependency on the Api
/// project. Implemented in the Api layer.</summary>
public interface ISmtpOptionsAccessor
{
    SmtpOptionsSnapshot Current { get; }
}
