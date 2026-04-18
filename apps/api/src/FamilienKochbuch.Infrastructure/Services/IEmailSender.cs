namespace FamilienKochbuch.Infrastructure.Services;

/// <summary>
/// Abstracts outbound email so the rest of the codebase doesn't depend on
/// a concrete SMTP client. Phase 1 only needs password-reset links; real
/// SMTP wiring lands in a later slice.
/// </summary>
public interface IEmailSender
{
    /// <summary>Sends a password-reset magic link to the given address.
    /// Implementations must never throw for unknown/invalid emails —
    /// password-reset always returns 204 to avoid user enumeration.</summary>
    Task SendPasswordResetAsync(string toEmail, string displayName, string resetUrl, CancellationToken ct = default);
}
