using SharedCookbook.Infrastructure.Services;
using Microsoft.Extensions.Options;

namespace SharedCookbook.Api.Services;

/// <summary>
/// Strongly-typed SMTP settings for the outbound email sender (PF3).
/// Bound from the <c>Smtp</c> config section; values originate in
/// <c>docker-compose.prod.yml</c> which maps <c>SMTP_*</c> env vars onto
/// <c>Smtp__*</c> keys. Empty <see cref="Host"/> or <see cref="FromAddress"/>
/// signals the DI registration to fall back to <c>NoOpEmailSender</c>.
/// </summary>
public sealed class SmtpOptions
{
    public const string SectionName = "Smtp";

    /// <summary>SMTP host (e.g. <c>smtp.migadu.com</c>). Empty disables SMTP.</summary>
    public string Host { get; set; } = string.Empty;

    /// <summary>SMTP submission port. Defaults to 587 (STARTTLS).</summary>
    public int Port { get; set; } = 587;

    /// <summary>SMTP authentication username.</summary>
    public string User { get; set; } = string.Empty;

    /// <summary>SMTP authentication password.</summary>
    public string Password { get; set; } = string.Empty;

    /// <summary>Envelope + header <c>From</c> address. Empty disables SMTP.</summary>
    public string FromAddress { get; set; } = string.Empty;

    /// <summary>Display name paired with <see cref="FromAddress"/>.</summary>
    public string FromName { get; set; } = "Familien-Kochbuch";

    /// <summary>Upgrade the connection with STARTTLS (default: true — matches
    /// Posteo / Migadu / most EU providers on port 587).</summary>
    public bool UseStartTls { get; set; } = true;
}

/// <summary>
/// Adapter that projects the Api-layer <see cref="SmtpOptions"/> into the
/// infrastructure-layer <see cref="SmtpOptionsSnapshot"/> consumed by
/// <see cref="SmtpEmailSender"/>. Keeps the Infrastructure project free
/// of an Api-project dependency.
/// </summary>
internal sealed class SmtpOptionsAccessor(IOptions<SmtpOptions> options) : ISmtpOptionsAccessor
{
    public SmtpOptionsSnapshot Current
    {
        get
        {
            var o = options.Value;
            return new SmtpOptionsSnapshot(
                o.Host, o.Port, o.User, o.Password, o.FromAddress, o.FromName, o.UseStartTls);
        }
    }
}
