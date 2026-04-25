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
        logger.LogInformation(
            "[DEV EMAIL] Password reset requested for {Email} ({DisplayName}): {ResetUrl}",
            toEmail, displayName, resetUrl);
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
            inviterDisplayName, toEmail);
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
            inviterDisplayName, toEmail, groupName);
        return Task.CompletedTask;
    }
}
