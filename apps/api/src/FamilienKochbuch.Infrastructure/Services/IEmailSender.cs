namespace FamilienKochbuch.Infrastructure.Services;

/// <summary>
/// Abstracts outbound email so the rest of the codebase doesn't depend on
/// a concrete SMTP client. Three transactional flows live behind this
/// interface: password reset, app-level signup invites, and per-group
/// member invites. Implementations may log-only (dev fallback) or deliver
/// via SMTP (<c>SmtpEmailSender</c>).
/// </summary>
public interface IEmailSender
{
    /// <summary>Sends a password-reset magic link to the given address.
    /// Implementations must never throw for unknown/invalid emails —
    /// password-reset always returns 204 to avoid user enumeration.</summary>
    Task SendPasswordResetAsync(
        string toEmail,
        string displayName,
        string resetUrl,
        CancellationToken ct = default);

    /// <summary>Sends an app-level signup invite. The recipient is not yet
    /// a registered user. <paramref name="personalNote"/> is an optional
    /// free-text line the inviter may have attached.</summary>
    Task SendAppInviteAsync(
        string toEmail,
        string inviterDisplayName,
        string acceptUrl,
        string? personalNote,
        CancellationToken ct = default);

    /// <summary>Sends a group-level invite. The recipient is already a
    /// registered user (group invites carry <c>InvitedUserId</c>), so the
    /// link drops them directly into the accept-invite flow.</summary>
    Task SendGroupInviteAsync(
        string toEmail,
        string inviterDisplayName,
        string groupName,
        string acceptUrl,
        CancellationToken ct = default);
}
