namespace FamilienKochbuch.Infrastructure.Services;

/// <summary>
/// Raised by <see cref="SmtpEmailSender"/> when the SMTP submission fails
/// for any reason (connection refused, auth failure, server reject, I/O
/// error). Callers must catch + log but MUST NOT bubble a 5xx up to the
/// user — password-reset / invite-create endpoints are authoritative on
/// their domain record regardless of mail delivery.
/// </summary>
public sealed class EmailSendException : Exception
{
    public EmailSendException(string message) : base(message) { }
    public EmailSendException(string message, Exception inner) : base(message, inner) { }
}
