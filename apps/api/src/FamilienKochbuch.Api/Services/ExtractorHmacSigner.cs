using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Options;

namespace FamilienKochbuch.Api.Services;

/// <summary>
/// Computes the three <c>X-Extractor-*</c> headers the Python extractor
/// service verifies on every request (see
/// <c>apps/python-extractor/src/extractor/security/hmac_middleware.py</c>).
///
/// Signature format:
/// <code>
/// HMAC-SHA256(userId + "|" + timestamp + "|" + bodyHash, sharedSecret)
/// bodyHash = SHA256(body).HexLower
/// timestamp = Unix seconds as a string
/// </code>
///
/// The 15-minute clock-skew window lives on the Python side — this signer
/// just stamps the current UTC second and lets the verifier decide.
/// The shared secret NEVER ends up in a log line; callers treat this
/// service as the single encapsulation point.
/// </summary>
public sealed class ExtractorHmacSigner
{
    /// <summary>Header name: hex-encoded HMAC-SHA256 signature.</summary>
    public const string SignatureHeader = "X-Extractor-Signature";

    /// <summary>Header name: unix-seconds timestamp (ASCII decimal).</summary>
    public const string TimestampHeader = "X-Extractor-Timestamp";

    /// <summary>Header name: caller user id (Guid "D" format).</summary>
    public const string UserIdHeader = "X-User-Id";

    private readonly byte[] _sharedSecretBytes;
    private readonly TimeProvider _clock;

    public ExtractorHmacSigner(IOptions<ExtractorOptions> options, TimeProvider clock)
    {
        if (options is null) throw new ArgumentNullException(nameof(options));
        var secret = options.Value.SharedSecret;
        if (string.IsNullOrEmpty(secret))
            throw new InvalidOperationException(
                "PythonExtractor:SharedSecret (EXTRACTOR_SHARED_SECRET) must be set.");

        _sharedSecretBytes = Encoding.UTF8.GetBytes(secret);
        _clock = clock;
    }

    /// <summary>A bundle of the three header values a caller applies to
    /// the outgoing request.</summary>
    public readonly record struct SignedHeaders(string UserId, string Timestamp, string Signature);

    /// <summary>Produces the three header values for the given caller +
    /// body.</summary>
    public SignedHeaders Sign(Guid userId, ReadOnlySpan<byte> body)
    {
        var ts = _clock.GetUtcNow().ToUnixTimeSeconds()
            .ToString(CultureInfo.InvariantCulture);
        var userIdStr = userId.ToString("D");
        var bodyHashHex = HexLower(SHA256.HashData(body));

        var payload = Encoding.UTF8.GetBytes($"{userIdStr}|{ts}|{bodyHashHex}");
        var sigBytes = HMACSHA256.HashData(_sharedSecretBytes, payload);
        var sigHex = HexLower(sigBytes);

        return new SignedHeaders(userIdStr, ts, sigHex);
    }

    /// <summary>Applies <see cref="Sign"/>'s output to an outgoing
    /// <see cref="HttpRequestMessage"/>. Keeps the three header names
    /// in one place so callers can't disagree on casing.</summary>
    public async Task ApplyAsync(HttpRequestMessage request, Guid userId, CancellationToken ct = default)
    {
        if (request is null) throw new ArgumentNullException(nameof(request));

        byte[] body;
        if (request.Content is null)
        {
            body = Array.Empty<byte>();
        }
        else
        {
            body = await request.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false);
        }

        var headers = Sign(userId, body);
        // Remove stale values if a caller is re-signing an attempt.
        request.Headers.Remove(UserIdHeader);
        request.Headers.Remove(TimestampHeader);
        request.Headers.Remove(SignatureHeader);
        request.Headers.Add(UserIdHeader, headers.UserId);
        request.Headers.Add(TimestampHeader, headers.Timestamp);
        request.Headers.Add(SignatureHeader, headers.Signature);
    }

    private static string HexLower(ReadOnlySpan<byte> bytes)
    {
        // Convert.ToHexString uppercases — lower-case keeps the wire
        // format byte-identical to the Python `hexdigest()` default.
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }
}
