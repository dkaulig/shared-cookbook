using FamilienKochbuch.Api.Services;
using Microsoft.Extensions.Options;
using Xunit;

namespace FamilienKochbuch.Api.Tests.Services;

/// <summary>
/// PV1 — round-trip + tamper resistance for
/// <see cref="ImportProgressTokenService"/>, the HMAC authenticator on
/// the Python → .NET progress callbacks.
/// </summary>
public class ImportProgressTokenServiceTests
{
    private static ImportProgressTokenService NewService(string secret = "test-secret-32-chars-minimum-aaaaa") =>
        new(Options.Create(new ExtractorOptions { SharedSecret = secret }));

    [Fact]
    public void Sign_Then_Verify_Round_Trips()
    {
        var svc = NewService();
        var importId = Guid.NewGuid();
        var now = new DateTimeOffset(2026, 4, 19, 12, 0, 0, TimeSpan.Zero);

        var token = svc.Sign(importId, now.AddMinutes(5));

        var ok = svc.TryVerify(token, importId, now, out var failure);
        Assert.True(ok);
        Assert.Equal(ImportTokenValidationFailure.None, failure);
    }

    [Fact]
    public void Expired_Token_Rejected()
    {
        var svc = NewService();
        var importId = Guid.NewGuid();
        var mintedAt = new DateTimeOffset(2026, 4, 19, 12, 0, 0, TimeSpan.Zero);
        var token = svc.Sign(importId, mintedAt.AddMinutes(5));

        var later = mintedAt.AddMinutes(10);
        var ok = svc.TryVerify(token, importId, later, out var failure);

        Assert.False(ok);
        Assert.Equal(ImportTokenValidationFailure.Expired, failure);
    }

    [Fact]
    public void Token_Exceeding_MaxLifetime_Is_Rejected()
    {
        // PV1 security — mis-wired signer baking a 24h expiry must not
        // be silently accepted. Verifier enforces the 10-minute cap
        // (MaxTokenLifetime) independently of the baked-in expiresAt.
        var svc = NewService();
        var importId = Guid.NewGuid();
        var now = new DateTimeOffset(2026, 4, 19, 12, 0, 0, TimeSpan.Zero);

        // Mint with a 24h TTL — way past the 10min cap.
        var longLivedToken = svc.Sign(importId, now.AddHours(24));

        var ok = svc.TryVerify(longLivedToken, importId, now, out var failure);

        Assert.False(ok);
        Assert.Equal(ImportTokenValidationFailure.Expired, failure);
    }

    [Fact]
    public void Token_At_MaxLifetime_Boundary_Is_Accepted()
    {
        // Tokens minted with exactly the 10-minute TTL must still verify —
        // the strict `>` comparison leaves the boundary valid.
        var svc = NewService();
        var importId = Guid.NewGuid();
        var now = new DateTimeOffset(2026, 4, 19, 12, 0, 0, TimeSpan.Zero);
        var token = svc.Sign(importId, now.Add(ImportProgressTokenService.MaxTokenLifetime));

        var ok = svc.TryVerify(token, importId, now, out var failure);

        Assert.True(ok);
        Assert.Equal(ImportTokenValidationFailure.None, failure);
    }

    [Fact]
    public void Wrong_Import_Id_Rejected()
    {
        var svc = NewService();
        var mintedFor = Guid.NewGuid();
        var requested = Guid.NewGuid();
        var now = new DateTimeOffset(2026, 4, 19, 12, 0, 0, TimeSpan.Zero);

        var token = svc.Sign(mintedFor, now.AddMinutes(5));
        var ok = svc.TryVerify(token, requested, now, out var failure);

        Assert.False(ok);
        Assert.Equal(ImportTokenValidationFailure.WrongImport, failure);
    }

    [Fact]
    public void Tampered_Signature_Rejected()
    {
        var svc = NewService();
        var id = Guid.NewGuid();
        var now = new DateTimeOffset(2026, 4, 19, 12, 0, 0, TimeSpan.Zero);

        var token = svc.Sign(id, now.AddMinutes(5));
        // Flip one character in the signature half.
        var dot = token.IndexOf('.');
        var body = token[..dot];
        var sig = token[(dot + 1)..];
        var flipped = body + "." + (sig[0] == 'A' ? 'B' : 'A') + sig[1..];

        var ok = svc.TryVerify(flipped, id, now, out var failure);
        Assert.False(ok);
        Assert.Equal(ImportTokenValidationFailure.BadSignature, failure);
    }

    [Fact]
    public void Cross_Secret_Rejected()
    {
        var signer = NewService("secret-a");
        var verifier = NewService("secret-b");
        var id = Guid.NewGuid();
        var now = new DateTimeOffset(2026, 4, 19, 12, 0, 0, TimeSpan.Zero);

        var token = signer.Sign(id, now.AddMinutes(5));
        var ok = verifier.TryVerify(token, id, now, out var failure);

        Assert.False(ok);
        Assert.Equal(ImportTokenValidationFailure.BadSignature, failure);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("not-a-token")]
    [InlineData("no-dot-separator")]
    [InlineData("..")]
    public void Malformed_Token_Rejected(string? token)
    {
        var svc = NewService();
        var ok = svc.TryVerify(token, Guid.NewGuid(), DateTimeOffset.UtcNow, out var failure);
        Assert.False(ok);
        Assert.Equal(ImportTokenValidationFailure.Malformed, failure);
    }

    [Fact]
    public void Empty_Secret_Throws_On_Construction()
    {
        Assert.Throws<InvalidOperationException>(() =>
            new ImportProgressTokenService(Options.Create(new ExtractorOptions { SharedSecret = string.Empty })));
    }

    [Fact]
    public void Sign_Rejects_Empty_ImportId()
    {
        var svc = NewService();
        Assert.Throws<ArgumentException>(() =>
            svc.Sign(Guid.Empty, DateTimeOffset.UtcNow.AddMinutes(5)));
    }
}
