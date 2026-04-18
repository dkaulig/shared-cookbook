namespace FamilienKochbuch.Infrastructure.Services;

/// <summary>
/// Options controlling JWT issuance and refresh-token lifetime. Bound
/// from the <c>Jwt</c> configuration section in <c>appsettings.*.json</c>
/// and overridable via the <c>JWT_SIGNING_KEY</c> environment variable.
/// </summary>
public class JwtOptions
{
    public const string SectionName = "Jwt";

    /// <summary>HMAC-SHA256 signing key. Must be at least 32 characters (256 bits).</summary>
    public string SigningKey { get; set; } = string.Empty;

    public string Issuer { get; set; } = "familien-kochbuch";

    public string Audience { get; set; } = "familien-kochbuch-web";

    public int AccessTokenLifetimeMinutes { get; set; } = 15;

    public int RefreshTokenLifetimeDays { get; set; } = 30;
}
