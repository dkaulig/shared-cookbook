using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Options;

namespace SharedCookbook.Api.Services;

/// <summary>
/// Reasons the per-import HMAC token attached to a Python progress
/// callback can be rejected. Surfaced to the endpoint so the log line
/// captures the precise failure without leaking any HMAC internals to
/// the 401 response body.
/// </summary>
public enum ImportTokenValidationFailure
{
    /// <summary>The token validated successfully — not actually a failure.</summary>
    None = 0,

    /// <summary>Token was empty / obviously not the base64url shape.</summary>
    Malformed = 1,

    /// <summary>HMAC signature did not match the expected digest.</summary>
    BadSignature = 2,

    /// <summary>Expiry timestamp has already passed.</summary>
    Expired = 3,

    /// <summary>Token was minted for a different importId.</summary>
    WrongImport = 4,
}

/// <summary>
/// Mints + verifies the short-lived per-import HMAC bearer tokens the
/// Python extractor carries on its progress-callback requests.
///
/// Token payload:
/// <code>
/// payload   = "{importId}|{expiresAtUnixSeconds}"
/// signature = HMAC-SHA256(payload, EXTRACTOR_SHARED_SECRET)
/// token     = base64url(payload) + "." + base64url(signature)
/// </code>
///
/// Design notes:
/// <list type="bullet">
/// <item>Scoped to a single <c>importId</c> so one leaked token cannot
/// be replayed against another import's progress endpoint.</item>
/// <item>10-minute TTL cap, tracked via the baked-in <c>expiresAt</c>
/// rather than a server-side session store — keeps the endpoint
/// stateless.</item>
/// <item>Constant-time signature comparison via
/// <see cref="CryptographicOperations.FixedTimeEquals(ReadOnlySpan{byte}, ReadOnlySpan{byte})"/>
/// so signature-length timing leaks can't be exploited.</item>
/// <item>Shares <see cref="ExtractorOptions.SharedSecret"/> with the
/// outgoing HMAC-signing path (<see cref="ExtractorHmacSigner"/>); both
/// sides use the same family-of-secrets concept — rotating the secret
/// rotates both directions simultaneously.</item>
/// </list>
/// </summary>
public sealed class ImportProgressTokenService
{
    /// <summary>Maximum token lifetime. The caller (job runner) mints
    /// with exactly this TTL; the verifier independently rejects BOTH
    /// (a) anything past the baked-in <c>expiresAt</c> (normal expiry)
    /// AND (b) tokens whose remaining lifetime exceeds this cap — so a
    /// mis-wired signer baking a 24 h <c>expiresAt</c> still fails
    /// validation after ten minutes instead of being silently
    /// accepted.</summary>
    public static readonly TimeSpan MaxTokenLifetime = TimeSpan.FromMinutes(10);

    private readonly byte[] _sharedSecretBytes;

    public ImportProgressTokenService(IOptions<ExtractorOptions> options)
    {
        if (options is null) throw new ArgumentNullException(nameof(options));
        var secret = options.Value.SharedSecret;
        if (string.IsNullOrEmpty(secret))
            throw new InvalidOperationException(
                "PythonExtractor:SharedSecret (EXTRACTOR_SHARED_SECRET) must be set.");
        _sharedSecretBytes = Encoding.UTF8.GetBytes(secret);
    }

    /// <summary>
    /// Signs a token scoped to <paramref name="importId"/> that expires
    /// at <paramref name="expiresAt"/>. Callers pass an expiry computed
    /// as <c>now + <see cref="MaxTokenLifetime"/></c>; if a caller mis-
    /// wires a longer TTL the verifier rejects the token on first use
    /// past the 10-minute cap — see <see cref="TryVerify"/>.
    /// </summary>
    public string Sign(Guid importId, DateTimeOffset expiresAt)
    {
        if (importId == Guid.Empty)
            throw new ArgumentException("importId must not be empty.", nameof(importId));

        var payloadStr = $"{importId:D}|{expiresAt.ToUnixTimeSeconds()}";
        var payloadBytes = Encoding.UTF8.GetBytes(payloadStr);
        var sigBytes = HMACSHA256.HashData(_sharedSecretBytes, payloadBytes);

        return $"{Base64Url(payloadBytes)}.{Base64Url(sigBytes)}";
    }

    /// <summary>
    /// Verifies the token against the current time + the expected
    /// importId. Returns <c>true</c> only when every check passes:
    /// base64url decodes, payload parses, HMAC matches, not expired,
    /// importId matches. On failure, <paramref name="failure"/> tells
    /// the caller which check failed — logged DEBUG-level by the
    /// endpoint; never surfaced to the 401 response body.
    /// </summary>
    public bool TryVerify(
        string? token,
        Guid expectedImportId,
        DateTimeOffset now,
        out ImportTokenValidationFailure failure)
    {
        failure = ImportTokenValidationFailure.None;
        if (string.IsNullOrWhiteSpace(token))
        {
            failure = ImportTokenValidationFailure.Malformed;
            return false;
        }

        // Split on the single '.' — exactly one separator. More or fewer
        // means the caller sent garbage.
        var dot = token.IndexOf('.');
        if (dot <= 0 || dot == token.Length - 1 || token.IndexOf('.', dot + 1) >= 0)
        {
            failure = ImportTokenValidationFailure.Malformed;
            return false;
        }
        var payloadB64 = token[..dot];
        var sigB64 = token[(dot + 1)..];

        byte[] payloadBytes;
        byte[] sigBytes;
        try
        {
            payloadBytes = FromBase64Url(payloadB64);
            sigBytes = FromBase64Url(sigB64);
        }
        catch (FormatException)
        {
            failure = ImportTokenValidationFailure.Malformed;
            return false;
        }

        if (sigBytes.Length != 32)
        {
            // HMAC-SHA256 digest is fixed 32 bytes; anything else is
            // tampered or another algorithm.
            failure = ImportTokenValidationFailure.BadSignature;
            return false;
        }

        // Constant-time signature compare — never short-circuit on the
        // first mismatching byte.
        var expectedSig = HMACSHA256.HashData(_sharedSecretBytes, payloadBytes);
        if (!CryptographicOperations.FixedTimeEquals(expectedSig, sigBytes))
        {
            failure = ImportTokenValidationFailure.BadSignature;
            return false;
        }

        // Now parse the payload: "{guid}|{unix-seconds}".
        var payloadStr = Encoding.UTF8.GetString(payloadBytes);
        var pipe = payloadStr.IndexOf('|');
        if (pipe <= 0 || pipe == payloadStr.Length - 1
            || payloadStr.IndexOf('|', pipe + 1) >= 0)
        {
            failure = ImportTokenValidationFailure.Malformed;
            return false;
        }
        var importIdStr = payloadStr[..pipe];
        var expiresStr = payloadStr[(pipe + 1)..];

        if (!Guid.TryParseExact(importIdStr, "D", out var tokenImportId))
        {
            failure = ImportTokenValidationFailure.Malformed;
            return false;
        }
        if (!long.TryParse(expiresStr,
                System.Globalization.NumberStyles.Integer,
                System.Globalization.CultureInfo.InvariantCulture,
                out var expiresSeconds))
        {
            failure = ImportTokenValidationFailure.Malformed;
            return false;
        }

        // Importance: compare importId BEFORE expiry so a cross-import
        // attempt returns WrongImport (clearer log) rather than Expired.
        if (tokenImportId != expectedImportId)
        {
            failure = ImportTokenValidationFailure.WrongImport;
            return false;
        }

        var expiresAt = DateTimeOffset.FromUnixTimeSeconds(expiresSeconds);
        if (now >= expiresAt)
        {
            failure = ImportTokenValidationFailure.Expired;
            return false;
        }

        // PV1 security — independently enforce MaxTokenLifetime at verify
        // time. The signer is supposed to mint with TTL ≤ 10 min, but a
        // mis-wired caller (or an older build sitting in a queue) might
        // bake a 24 h expiry. Checking (expiresAt - now) > MaxTokenLifetime
        // means such a token fails validation after the 10-minute mark
        // regardless of what the baked-in expiresAt claims. A token minted
        // exactly on the cap (expiresAt - now == MaxTokenLifetime) stays
        // valid; the strict `>` comparison leaves a tiny clock-skew
        // margin on the boundary.
        if (expiresAt - now > MaxTokenLifetime)
        {
            failure = ImportTokenValidationFailure.Expired;
            return false;
        }

        return true;
    }

    // ── Base64URL helpers ──────────────────────────────────────────────
    //
    // RFC 4648 §5 base64url: replace '+' with '-', '/' with '_', and
    // strip trailing '=' padding. Compact + URL-safe; identical to what
    // the Python standard library's `base64.urlsafe_b64encode` produces
    // (modulo the padding strip) so cross-runtime interop is trivial if
    // a future non-.NET caller needs it.

    private static string Base64Url(ReadOnlySpan<byte> bytes)
    {
        var b64 = Convert.ToBase64String(bytes);
        return b64.TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    private static byte[] FromBase64Url(string input)
    {
        var b64 = input.Replace('-', '+').Replace('_', '/');
        switch (b64.Length % 4)
        {
            case 2: b64 += "=="; break;
            case 3: b64 += "="; break;
            case 0: break;
            default:
                // length % 4 == 1 is invalid base64 — cannot represent
                // any byte sequence. Treat as malformed.
                throw new FormatException("Invalid base64url length.");
        }
        return Convert.FromBase64String(b64);
    }
}
