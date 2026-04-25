using System;
using SharedCookbook.Api.Services;
using Xunit;

namespace SharedCookbook.Api.Tests.Services;

/// <summary>
/// BUG-013 — <see cref="UrlNormaliser"/> is the canonicalisation layer
/// for the URL-import cache lookup in
/// <c>ImportEndpoints.EnqueueUrlImportAsync</c>. These tests pin the
/// behaviour: two URLs that differ only by tracking-noise or host
/// casing must collapse to the same canonical string so the cache-hit
/// actually fires on re-paste, while semantically distinct URLs must
/// stay distinct.
/// </summary>
public class UrlNormaliserTests
{
    [Fact]
    public void Lowercases_Scheme_And_Host()
    {
        var normalised = UrlNormaliser.Normalise("HTTPS://FB.com/Some/Path");
        Assert.StartsWith("https://fb.com/", normalised, StringComparison.Ordinal);
    }

    [Fact]
    public void Preserves_Path_Case_And_Trailing_Slash()
    {
        // Casing on the path and the trailing slash are meaningful to many
        // servers — we do not touch them, which keeps the canonical form
        // a strict subset of the input rather than a guess-work rewrite.
        Assert.Equal(
            "https://example.com/Recipes/Spaetzle/",
            UrlNormaliser.Normalise("https://example.com/Recipes/Spaetzle/"));
        Assert.Equal(
            "https://example.com/Recipes/Spaetzle",
            UrlNormaliser.Normalise("https://example.com/Recipes/Spaetzle"));
    }

    [Theory]
    [InlineData("fbclid")]
    [InlineData("gclid")]
    [InlineData("mibextid")]
    [InlineData("_ga")]
    [InlineData("ref_src")]
    [InlineData("ref_url")]
    [InlineData("igshid")]
    [InlineData("si")]
    [InlineData("feature")]
    public void Strips_Known_Exact_Match_Tracking_Params(string name)
    {
        var normalised = UrlNormaliser.Normalise($"https://example.com/r?{name}=whatever");
        Assert.Equal("https://example.com/r", normalised);
    }

    [Theory]
    [InlineData("utm_source")]
    [InlineData("utm_medium")]
    [InlineData("utm_campaign")]
    [InlineData("utm_term")]
    [InlineData("utm_content")]
    [InlineData("utm_id")]
    [InlineData("UTM_Source")]
    public void Strips_Utm_Prefix_Params(string name)
    {
        var normalised = UrlNormaliser.Normalise($"https://example.com/r?{name}=x&keep=1");
        Assert.Equal("https://example.com/r?keep=1", normalised);
    }

    [Fact]
    public void Keeps_Other_Query_Params_Verbatim()
    {
        // Non-tracking params must survive — YouTube's `v=` + `t=` are
        // semantically meaningful (different video, different time
        // stamp). Collapsing them would cache distinct videos under the
        // same key.
        var normalised = UrlNormaliser.Normalise(
            "https://youtube.com/watch?v=dQw4w9WgXcQ&t=42&utm_source=x");
        Assert.Equal(
            "https://youtube.com/watch?v=dQw4w9WgXcQ&t=42",
            normalised);
    }

    [Fact]
    public void Collapses_Different_Casings_To_Same_Canonical_String()
    {
        // The BUG-013 "different-share-source, same video" hit scenario:
        // Facebook likes to rewrite host case + attach fbclid. Both forms
        // must canonicalise identically so the cache lookup hits.
        var a = UrlNormaliser.Normalise("https://FB.com/reel/123?fbclid=AAA&mibextid=BBB");
        var b = UrlNormaliser.Normalise("https://fb.com/reel/123?fbclid=ZZZ");
        Assert.Equal(a, b);
        Assert.Equal("https://fb.com/reel/123", a);
    }

    [Fact]
    public void Drops_Default_Port_But_Keeps_Explicit_Non_Default()
    {
        Assert.Equal(
            "https://example.com/r",
            UrlNormaliser.Normalise("https://example.com:443/r"));
        Assert.Equal(
            "http://example.com/r",
            UrlNormaliser.Normalise("http://example.com:80/r"));
        Assert.Equal(
            "https://example.com:8443/r",
            UrlNormaliser.Normalise("https://example.com:8443/r"));
    }

    [Fact]
    public void Preserves_Fragment()
    {
        // Fragments can encode SPA routing / YouTube timestamps. Do not
        // strip.
        var normalised = UrlNormaliser.Normalise("https://example.com/r#t=42");
        Assert.EndsWith("#t=42", normalised, StringComparison.Ordinal);
    }

    [Fact]
    public void Leaves_Input_Unchanged_When_Already_Canonical()
    {
        // The caller is expected to pass already-validated absolute
        // URLs, but we still canonicalise idempotently: running Normalise
        // on its own output yields the same string.
        var first = UrlNormaliser.Normalise("https://example.com/a/b?x=1&fbclid=y");
        var second = UrlNormaliser.Normalise(first);
        Assert.Equal(first, second);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData(null)]
    public void Throws_On_Empty_Or_Null(string? raw)
    {
        Assert.Throws<ArgumentException>(() => UrlNormaliser.Normalise(raw!));
    }

    [Fact]
    public void Trims_Surrounding_Whitespace()
    {
        Assert.Equal(
            "https://example.com/r",
            UrlNormaliser.Normalise("   https://example.com/r   "));
    }

    [Fact]
    public void Preserves_Query_Param_Ordering()
    {
        // UriBuilder-driven rewrite must NOT reorder the surviving
        // params — downstream string comparison relies on a stable
        // canonical form.
        Assert.Equal(
            "https://example.com/r?a=1&b=2&c=3",
            UrlNormaliser.Normalise("https://example.com/r?a=1&b=2&c=3&fbclid=x"));
    }
}
