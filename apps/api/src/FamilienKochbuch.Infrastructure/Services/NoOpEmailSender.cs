using Microsoft.Extensions.Logging;

namespace FamilienKochbuch.Infrastructure.Services;

/// <summary>
/// Dev / test implementation of <see cref="IEmailSender"/> that just logs
/// the outgoing message. Phase 1 does not wire a real SMTP sender yet —
/// the reset link is also printed to the logs so developers can copy it
/// out when testing the flow without an SMTP server.
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
}
