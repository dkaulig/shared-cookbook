using FamilienKochbuch.Infrastructure.Services;
using Microsoft.Extensions.Logging;

namespace FamilienKochbuch.Api.Services;

/// <summary>
/// Shared best-effort wrapper around the three <see cref="IEmailSender"/>
/// call-sites (password-reset, app-invite, group-invite). Catches
/// <see cref="EmailSendException"/> and logs a warning so the calling
/// endpoint can continue to return its authoritative 2xx — mail delivery
/// is never allowed to surface as a 5xx.
/// </summary>
internal static class EmailDeliveryHelper
{
    /// <summary>
    /// Invokes <paramref name="send"/> and swallows
    /// <see cref="EmailSendException"/>. The <paramref name="contextId"/>
    /// is emitted in the warning log so ops can correlate the failure to
    /// the specific user / invite / group-invite that tried to send.
    /// </summary>
    public static async Task TrySendAsync(
        Func<CancellationToken, Task> send,
        ILogger logger,
        string contextId,
        CancellationToken ct)
    {
        try
        {
            await send(ct);
        }
        catch (EmailSendException ex)
        {
            logger.LogWarning(ex,
                "Email delivery failed for {ContextId}",
                contextId);
        }
    }
}
