using System.Globalization;
using FamilienKochbuch.Api.Services;
using Microsoft.Extensions.Configuration;
using Xunit;

namespace FamilienKochbuch.Api.Tests.Services;

/// <summary>
/// Contract tests for <see cref="ImageSigningService"/>. Mirrors hoppr's
/// <c>ImageSigningServiceTests</c> (roundtrip, tamper, expiry,
/// null-signature, missing-secret) but points at our own <c>Jwt:SigningKey</c>
/// config key and exercises the 2 h default when
/// <c>Images:SignatureValidityHours</c> is absent.
/// </summary>
public class ImageSigningServiceTests
{
    private const string TestJwtKey = "integration-test-signing-key-definitely-long-enough-32chars!";

    private static ImageSigningService CreateService(
        string jwtKey = TestJwtKey,
        double? validityHours = null)
    {
        var data = new Dictionary<string, string?>
        {
            ["Jwt:SigningKey"] = jwtKey,
        };
        if (validityHours.HasValue)
        {
            data["Images:SignatureValidityHours"] =
                validityHours.Value.ToString(CultureInfo.InvariantCulture);
        }

        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(data)
            .Build();

        return new ImageSigningService(config);
    }

    private static (string Sig, long Exp) ParseSignedUrl(string signedUrl)
    {
        var query = signedUrl.Split('?')[1];
        var parts = query.Split('&');
        var sig = parts[0].Split('=')[1];
        var exp = long.Parse(parts[1].Split('=')[1], CultureInfo.InvariantCulture);
        return (sig, exp);
    }

    // ── Sign then validate ──────────────────────────────────────────

    [Fact]
    public void SignUrl_ThenValidate_ReturnsTrue()
    {
        var svc = CreateService();
        var filePath = "recipes/abc123/photo.jpg";

        var signedUrl = svc.SignUrl("/api/photos/" + filePath, filePath);
        var (sig, exp) = ParseSignedUrl(signedUrl);

        Assert.True(svc.Validate(filePath, sig, exp));
    }

    [Fact]
    public void SignUrl_ReturnsUrlWithSigAndExp()
    {
        var svc = CreateService();

        var signedUrl = svc.SignUrl("/api/photos/test.jpg", "test.jpg");

        Assert.Contains("?sig=", signedUrl);
        Assert.Contains("&exp=", signedUrl);
    }

    [Fact]
    public void SignUrl_UrlSafeBase64_NoPlusOrSlashOrPadding()
    {
        var svc = CreateService();

        // Run several times to catch base64 padding/'+'/'/' drift.
        for (var i = 0; i < 50; i++)
        {
            var path = $"recipes/batch-{i}.jpg";
            var signedUrl = svc.SignUrl("/api/photos/" + path, path);
            var (sig, _) = ParseSignedUrl(signedUrl);
            Assert.DoesNotContain('+', sig);
            Assert.DoesNotContain('/', sig);
            Assert.DoesNotContain('=', sig);
        }
    }

    // ── Tampered signature ──────────────────────────────────────────

    [Fact]
    public void Validate_TamperedSignature_SingleCharFlip_ReturnsFalse()
    {
        var svc = CreateService();
        var filePath = "recipes/abc/photo.jpg";

        var signedUrl = svc.SignUrl("/api/photos/" + filePath, filePath);
        var (sig, exp) = ParseSignedUrl(signedUrl);

        // Flip one character of the signature in a way that always differs.
        var swapped = sig[0] == 'A' ? 'B' : 'A';
        var tamperedSig = swapped + sig[1..];

        Assert.False(svc.Validate(filePath, tamperedSig, exp));
    }

    [Fact]
    public void Validate_TotallyBogusSignature_ReturnsFalse()
    {
        var svc = CreateService();
        var exp = DateTimeOffset.UtcNow.AddHours(2).ToUnixTimeSeconds();

        Assert.False(svc.Validate("x.jpg", "AAAA_bogus_signature_AAAA", exp));
    }

    // ── Tampered path ───────────────────────────────────────────────

    [Fact]
    public void Validate_TamperedPath_SameSigAndExp_ReturnsFalse()
    {
        var svc = CreateService();
        var filePath = "recipes/abc/photo.jpg";

        var signedUrl = svc.SignUrl("/api/photos/" + filePath, filePath);
        var (sig, exp) = ParseSignedUrl(signedUrl);

        Assert.False(svc.Validate("recipes/abc/DIFFERENT.jpg", sig, exp));
    }

    // ── Expired signature ───────────────────────────────────────────

    [Fact]
    public void Validate_ExpInPast_ReturnsFalse()
    {
        var svc = CreateService();
        var filePath = "recipes/abc/photo.jpg";
        var signedUrl = svc.SignUrl("/api/photos/" + filePath, filePath);
        var (sig, _) = ParseSignedUrl(signedUrl);

        var pastExp = DateTimeOffset.UtcNow.AddHours(-1).ToUnixTimeSeconds();

        Assert.False(svc.Validate(filePath, sig, pastExp));
    }

    // ── Missing signature ───────────────────────────────────────────

    [Fact]
    public void Validate_NullSig_ReturnsFalse()
    {
        var svc = CreateService();
        var exp = DateTimeOffset.UtcNow.AddHours(2).ToUnixTimeSeconds();

        Assert.False(svc.Validate("x.jpg", null, exp));
    }

    [Fact]
    public void Validate_EmptySig_ReturnsFalse()
    {
        var svc = CreateService();
        var exp = DateTimeOffset.UtcNow.AddHours(2).ToUnixTimeSeconds();

        Assert.False(svc.Validate("x.jpg", string.Empty, exp));
    }

    // ── Config defaults ─────────────────────────────────────────────

    [Fact]
    public void SignUrl_DefaultValidity_IsTwoHours_WhenConfigAbsent()
    {
        var svc = CreateService(validityHours: null);
        var before = DateTimeOffset.UtcNow.ToUnixTimeSeconds();

        var signedUrl = svc.SignUrl("/api/photos/x.jpg", "x.jpg");
        var (_, exp) = ParseSignedUrl(signedUrl);

        var delta = exp - before;
        // Expect ~7200 s; allow a small window for test scheduling jitter.
        Assert.InRange(delta, 7200 - 5, 7200 + 5);
    }

    [Fact]
    public void SignUrl_CustomValidity_IsHonoured()
    {
        // 1 minute = 1/60 h ≈ 0.01666...
        var svc = CreateService(validityHours: 1.0 / 60.0);
        var before = DateTimeOffset.UtcNow.ToUnixTimeSeconds();

        var signedUrl = svc.SignUrl("/api/photos/x.jpg", "x.jpg");
        var (_, exp) = ParseSignedUrl(signedUrl);

        var delta = exp - before;
        Assert.InRange(delta, 60 - 5, 60 + 5);
    }

    // ── Construction invariants ─────────────────────────────────────

    [Fact]
    public void Construction_MissingJwtSigningKey_Throws()
    {
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>())
            .Build();

        Assert.Throws<InvalidOperationException>(() => new ImageSigningService(config));
    }

    // ── Different secrets yield different signatures ────────────────

    [Fact]
    public void Validate_SignatureFromDifferentSecret_ReturnsFalse()
    {
        var a = CreateService(jwtKey: "secret-one-that-is-long-enough-for-signing!!");
        var b = CreateService(jwtKey: "secret-two-that-is-long-enough-for-signing!!");
        var filePath = "recipes/abc/photo.jpg";

        var signedA = a.SignUrl("/api/photos/" + filePath, filePath);
        var (sigA, expA) = ParseSignedUrl(signedA);

        Assert.False(b.Validate(filePath, sigA, expA));
    }
}
