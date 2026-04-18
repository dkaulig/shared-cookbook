using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace FamilienKochbuch.Api.Services;

/// <summary>
/// HMAC-SHA256 URL signer for the photo proxy endpoint. The signing key is
/// derived from <c>Jwt:SigningKey</c> via
/// <c>SHA256("img-sign:" + jwtKey)</c> so that rotating the JWT secret also
/// rotates outstanding photo URLs.
///
/// Signature payload is <c>"{filePath}:{exp}"</c>, the signature itself is
/// URL-safe base64 (<c>+</c> → <c>-</c>, <c>/</c> → <c>_</c>, padding
/// stripped). Validation uses <see cref="CryptographicOperations.FixedTimeEquals"/>
/// to avoid timing attacks.
///
/// Mirrors <c>Hoppr.Api.Services.ImageSigningService</c> in every detail
/// except the config key (we use <c>Jwt:SigningKey</c>, hoppr uses
/// <c>Jwt:Key</c>).
/// </summary>
public class ImageSigningService
{
    private readonly byte[] _key;
    private readonly TimeSpan _defaultValidity;

    public ImageSigningService(IConfiguration config)
    {
        var secret = config["Jwt:SigningKey"]
            ?? throw new InvalidOperationException(
                "Jwt:SigningKey is required for image signing.");
        _key = SHA256.HashData(Encoding.UTF8.GetBytes("img-sign:" + secret));

        var configuredHours = config["Images:SignatureValidityHours"];
        var hours = 2.0;
        if (!string.IsNullOrWhiteSpace(configuredHours)
            && double.TryParse(configuredHours, NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed))
        {
            hours = parsed;
        }
        _defaultValidity = TimeSpan.FromHours(hours);
    }

    /// <summary>Produces <c>{basePath}?sig=X&amp;exp=Y</c> with the default validity.</summary>
    public string SignUrl(string basePath, string filePath)
        => SignUrl(basePath, filePath, _defaultValidity);

    /// <summary>Produces <c>{basePath}?sig=X&amp;exp=Y</c> with a custom validity window.</summary>
    public string SignUrl(string basePath, string filePath, TimeSpan validity)
    {
        var exp = DateTimeOffset.UtcNow.Add(validity).ToUnixTimeSeconds();
        var sig = ComputeSignature(filePath, exp);
        return $"{basePath}?sig={sig}&exp={exp}";
    }

    /// <summary>Validates that <paramref name="sig"/> was issued by this service
    /// for the given <paramref name="filePath"/> and has not yet expired.</summary>
    public bool Validate(string filePath, string? sig, long exp)
    {
        if (string.IsNullOrEmpty(sig)) return false;
        if (DateTimeOffset.UtcNow.ToUnixTimeSeconds() > exp) return false;

        var expected = ComputeSignature(filePath, exp);
        return CryptographicOperations.FixedTimeEquals(
            Encoding.UTF8.GetBytes(sig),
            Encoding.UTF8.GetBytes(expected));
    }

    private string ComputeSignature(string path, long exp)
    {
        var data = Encoding.UTF8.GetBytes($"{path}:{exp}");
        var hash = HMACSHA256.HashData(_key, data);
        return Convert.ToBase64String(hash)
            .Replace("+", "-")
            .Replace("/", "_")
            .TrimEnd('=');
    }
}
