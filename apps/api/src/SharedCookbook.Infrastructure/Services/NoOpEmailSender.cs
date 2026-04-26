using Microsoft.Extensions.Logging;

namespace SharedCookbook.Infrastructure.Services;

/// <summary>
/// Dev / test implementation of <see cref="IEmailSender"/> that just logs
/// each outgoing message. Activated when no SMTP host is configured, so
/// reset + invite links appear in the API container logs and developers
/// can copy them out when running the stack without an SMTP server.
///
/// Security note: we log the URL for password-reset (dev-only convenience)
/// but ONLY the subject + recipient for invite mails, matching the rule
/// that body content never hits the log at INFO in production.
/// </summary>
public class NoOpEmailSender(ILogger<NoOpEmailSender> logger) : IEmailSender
{
    public Task SendPasswordResetAsync(
        string toEmail,
        string displayName,
        string resetUrl,
        CancellationToken ct = default)
    {
        // Email masked. URL stays intact: this is the dev-only sender
        // whose entire purpose is to surface the reset link in the API
        // container logs so devs can copy + paste it without an SMTP
        // server. Production never reaches this branch (SmtpEmailSender
        // is wired up when SMTP host is configured).
        logger.LogInformation(
            "[DEV EMAIL] Password reset requested for {Email} ({DisplayName}): {ResetUrl}",
            EmailMasking.Mask(toEmail), displayName, resetUrl);
        return Task.CompletedTask;
    }

    public Task SendAppInviteAsync(
        string toEmail,
        string inviterDisplayName,
        string acceptUrl,
        string? personalNote,
        CancellationToken ct = default)
    {
        logger.LogInformation(
            "[DEV EMAIL] App invite from {Inviter} to {Email} (subject: Einladung zum Familien-Kochbuch)",
            inviterDisplayName, EmailMasking.Mask(toEmail));
        return Task.CompletedTask;
    }

    public Task SendGroupInviteAsync(
        string toEmail,
        string inviterDisplayName,
        string groupName,
        string acceptUrl,
        CancellationToken ct = default)
    {
        logger.LogInformation(
            "[DEV EMAIL] Group invite from {Inviter} to {Email} for group {GroupName} (subject: Einladung zur Gruppe)",
            inviterDisplayName, EmailMasking.Mask(toEmail), groupName);
        return Task.CompletedTask;
    }
}
