using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using SharedCookbook.Api.Services;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Time.Testing;
using Xunit;

namespace SharedCookbook.Api.Tests.Services;

/// <summary>
/// Unit tests for <see cref="ExtractorHmacSigner"/>. Locks the wire
/// format down so the Python verifier doesn't drift.
/// </summary>
public class ExtractorHmacSignerTests
{
    private const string Secret = "dev-only-shared-secret";

    private static ExtractorHmacSigner CreateSigner(
        FakeTimeProvider? clock = null,
        string secret = Secret)
    {
        var opts = Options.Create(new ExtractorOptions
        {
            SharedSecret = secret,
            BaseUrl = "http://python-extractor:8000",
        });
        return new ExtractorHmacSigner(opts, clock ?? new FakeTimeProvider(
            new DateTimeOffset(2026, 4, 18, 12, 0, 0, TimeSpan.Zero)));
    }

    [Fact]
    public void Constructor_Rejects_Missing_Secret()
    {
        var opts = Options.Create(new ExtractorOptions { SharedSecret = string.Empty });
        Assert.Throws<InvalidOperationException>(() =>
            new ExtractorHmacSigner(opts, TimeProvider.System));
    }

    [Fact]
    public void Sign_Is_Deterministic_For_Same_Inputs_And_Same_Clock()
    {
        var clock = new FakeTimeProvider(
            new DateTimeOffset(2026, 4, 18, 12, 0, 0, TimeSpan.Zero));
        var signer = CreateSigner(clock);
        var userId = Guid.Parse("00000000-0000-0000-0000-000000000001");
        var body = Encoding.UTF8.GetBytes("{\"url\":\"https://example.com\"}");

        var a = signer.Sign(userId, body);
        var b = signer.Sign(userId, body);

        Assert.Equal(a.Signature, b.Signature);
        Assert.Equal(a.Timestamp, b.Timestamp);
        Assert.Equal(a.UserId, b.UserId);
    }

    [Fact]
    public void Sign_Timestamp_Tracks_Clock()
    {
        var t0 = new DateTimeOffset(2026, 4, 18, 12, 0, 0, TimeSpan.Zero);
        var clock = new FakeTimeProvider(t0);
        var signer = CreateSigner(clock);
        var userId = Guid.NewGuid();
        var body = new byte[0];

        var first = signer.Sign(userId, body);

        clock.Advance(TimeSpan.FromSeconds(60));
        var second = signer.Sign(userId, body);

        Assert.Equal(t0.ToUnixTimeSeconds().ToString(), first.Timestamp);
        Assert.Equal((t0.ToUnixTimeSeconds() + 60).ToString(), second.Timestamp);
        // Different timestamps → different signatures even for identical body.
        Assert.NotEqual(first.Signature, second.Signature);
    }

    [Fact]
    public void Sign_Changes_When_Body_Changes()
    {
        var signer = CreateSigner();
        var userId = Guid.NewGuid();
        var first = signer.Sign(userId, Encoding.UTF8.GetBytes("{}"));
        var second = signer.Sign(userId, Encoding.UTF8.GetBytes("{\"x\":1}"));

        Assert.NotEqual(first.Signature, second.Signature);
        Assert.Equal(first.Timestamp, second.Timestamp);
    }

    [Fact]
    public void Sign_Matches_Reference_Implementation()
    {
        // Exact wire format the Python middleware must reproduce.
        // Computed by hand against HMAC-SHA256(
        //   "11111111-1111-1111-1111-111111111111|1700000000|<bodyHash>",
        //   "dev-only-shared-secret").hexdigest()
        var clock = new FakeTimeProvider(
            DateTimeOffset.FromUnixTimeSeconds(1_700_000_000));
        var signer = CreateSigner(clock);
        var userId = Guid.Parse("11111111-1111-1111-1111-111111111111");
        var body = Encoding.UTF8.GetBytes("hello");

        var signed = signer.Sign(userId, body);

        // Re-derive from scratch to assert the format.
        var bodyHash = Convert.ToHexString(SHA256.HashData(body)).ToLowerInvariant();
        var payload = $"11111111-1111-1111-1111-111111111111|1700000000|{bodyHash}";
        var key = Encoding.UTF8.GetBytes(Secret);
        var expected = Convert.ToHexString(
            HMACSHA256.HashData(key, Encoding.UTF8.GetBytes(payload))).ToLowerInvariant();

        Assert.Equal("11111111-1111-1111-1111-111111111111", signed.UserId);
        Assert.Equal("1700000000", signed.Timestamp);
        Assert.Equal(expected, signed.Signature);
    }

    [Fact]
    public async Task ApplyAsync_Adds_All_Three_Headers()
    {
        var signer = CreateSigner();
        using var request = new HttpRequestMessage(HttpMethod.Post, "http://x/extract/url")
        {
            Content = JsonContent.Create(new { url = "https://example.com" }),
        };
        var userId = Guid.Parse("00000000-0000-0000-0000-000000000abc");

        await signer.ApplyAsync(request, userId);

        Assert.True(request.Headers.TryGetValues(
            ExtractorHmacSigner.UserIdHeader, out var userIdValues));
        Assert.Single(userIdValues!);
        Assert.True(request.Headers.TryGetValues(
            ExtractorHmacSigner.TimestampHeader, out var tsValues));
        Assert.Single(tsValues!);
        Assert.True(request.Headers.TryGetValues(
            ExtractorHmacSigner.SignatureHeader, out var sigValues));
        Assert.Single(sigValues!);
    }

    [Fact]
    public async Task ApplyAsync_Replaces_Stale_Headers_On_Second_Call()
    {
        var clock = new FakeTimeProvider(
            new DateTimeOffset(2026, 4, 18, 12, 0, 0, TimeSpan.Zero));
        var signer = CreateSigner(clock);
        using var request = new HttpRequestMessage(HttpMethod.Post, "http://x/extract/url")
        {
            Content = new StringContent("payload-1"),
        };
        var userId = Guid.NewGuid();

        await signer.ApplyAsync(request, userId);
        var firstTs = request.Headers.GetValues(ExtractorHmacSigner.TimestampHeader).Single();

        clock.Advance(TimeSpan.FromMinutes(3));
        // Second apply should strip the stale headers and emit a fresh set.
        await signer.ApplyAsync(request, userId);
        var secondTs = request.Headers.GetValues(ExtractorHmacSigner.TimestampHeader).Single();

        Assert.NotEqual(firstTs, secondTs);
        Assert.Single(request.Headers.GetValues(ExtractorHmacSigner.SignatureHeader));
    }
}
