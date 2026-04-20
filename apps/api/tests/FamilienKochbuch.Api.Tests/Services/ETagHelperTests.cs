using FamilienKochbuch.Api.Http;
using Xunit;

namespace FamilienKochbuch.Api.Tests.Services;

/// <summary>
/// OFF3: unit tests for the weak-ETag encoder/decoder used on the
/// mutation endpoints. Parser must accept both the strong and weak
/// forms, reject nonsense, and round-trip cleanly through
/// <see cref="ETagHelper.Compute"/> → <see cref="ETagHelper.TryParse"/>.
/// </summary>
public class ETagHelperTests
{
    private static readonly Guid SampleId = Guid.Parse("11111111-2222-3333-4444-555555555555");

    [Fact]
    public void Compute_Produces_Weak_Etag_In_D_Format()
    {
        var etag = ETagHelper.Compute(SampleId, 7);
        Assert.Equal("W/\"11111111-2222-3333-4444-555555555555-7\"", etag);
    }

    [Fact]
    public void Compute_TryParse_Roundtrip()
    {
        var etag = ETagHelper.Compute(SampleId, 42);
        var parsed = ETagHelper.TryParse(etag);

        Assert.NotNull(parsed);
        Assert.Equal(SampleId, parsed!.Value.Id);
        Assert.Equal(42, parsed.Value.Version);
    }

    [Fact]
    public void TryParse_Accepts_Strong_Form()
    {
        var strong = $"\"{SampleId:D}-3\"";
        var parsed = ETagHelper.TryParse(strong);

        Assert.NotNull(parsed);
        Assert.Equal(SampleId, parsed!.Value.Id);
        Assert.Equal(3, parsed.Value.Version);
    }

    [Fact]
    public void TryParse_Accepts_Weak_Form_With_Space_After_Slash()
    {
        // Some clients round-trip the header with an extra space after
        // W/ which is permissive per RFC 7232. Parser tolerates it.
        var raw = $"W/ \"{SampleId:D}-5\"";
        var parsed = ETagHelper.TryParse(raw);

        Assert.NotNull(parsed);
        Assert.Equal(SampleId, parsed!.Value.Id);
        Assert.Equal(5, parsed.Value.Version);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("*")]
    [InlineData("not-a-tag")]
    [InlineData("W/not-quoted")]
    [InlineData("W/\"no-guid-here-0\"")]
    [InlineData("W/\"\"")]
    [InlineData("W/\"11111111-2222-3333-4444-555555555555\"")] // missing -version
    [InlineData("W/\"11111111-2222-3333-4444-555555555555-abc\"")]
    [InlineData("W/\"11111111-2222-3333-4444-555555555555--1\"")] // negative version
    [InlineData("W/\"-7\"")] // empty id part
    [InlineData("W/\"11111111-2222-3333-4444-555555555555-\"")] // trailing dash, no version digits
    public void TryParse_Returns_Null_For_Garbage(string? input)
    {
        Assert.Null(ETagHelper.TryParse(input));
    }

    [Fact]
    public void TryParse_Rejects_Wildcard_Star()
    {
        // RFC allows If-Match: * to mean "match any existing entity",
        // but our tokens are always (id, version) so we reject it so
        // callers don't accidentally skip the concurrency check.
        Assert.Null(ETagHelper.TryParse("*"));
    }

    [Fact]
    public void Compute_Is_Stable_Across_Calls()
    {
        var a = ETagHelper.Compute(SampleId, 1);
        var b = ETagHelper.Compute(SampleId, 1);
        Assert.Equal(a, b);
    }

    [Fact]
    public void Compute_Different_Versions_Yield_Different_ETags()
    {
        var v1 = ETagHelper.Compute(SampleId, 1);
        var v2 = ETagHelper.Compute(SampleId, 2);
        Assert.NotEqual(v1, v2);
    }
}
