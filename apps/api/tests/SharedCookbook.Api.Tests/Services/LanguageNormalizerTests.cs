using SharedCookbook.Api.Services;
using Xunit;

namespace SharedCookbook.Api.Tests.Services;

/// <summary>
/// LANG-1 — invariants for <see cref="LanguageNormalizer.Normalise"/>.
/// Pinned alongside the Python equivalent's pytest matrix so the two
/// language gates stay in lockstep — any divergence here would let one
/// side accept a header the other rejects.
/// </summary>
public class LanguageNormalizerTests
{
    [Theory]
    // Plain language tags.
    [InlineData("de", "de")]
    [InlineData("en", "en")]
    // Region suffixes — strip and lowercase.
    [InlineData("de-DE", "de")]
    [InlineData("de-AT", "de")]
    [InlineData("de-CH", "de")]
    [InlineData("en-US", "en")]
    [InlineData("en-GB", "en")]
    // Case-insensitive matching.
    [InlineData("DE", "de")]
    [InlineData("En-Us", "en")]
    // Quality-weighted lists — first preference wins, weights ignored.
    [InlineData("de, en;q=0.8", "de")]
    [InlineData("en, de;q=0.5", "en")]
    [InlineData("de-DE,de;q=0.9,en;q=0.8", "de")]
    [InlineData("en-GB,en-US;q=0.9,en;q=0.8,de;q=0.7", "en")]
    // Whitespace tolerance.
    [InlineData("  de  ", "de")]
    [InlineData(" en-US , de;q=0.5 ", "en")]
    // Unsupported languages → en fallback (matches REL-3h).
    [InlineData("fr", "en")]
    [InlineData("zh-CN", "en")]
    [InlineData("ja", "en")]
    [InlineData("fr-FR,it;q=0.8,es;q=0.5", "en")]
    // Wildcard.
    [InlineData("*", "en")]
    // Empty / whitespace / null.
    [InlineData("", "en")]
    [InlineData("   ", "en")]
    [InlineData(null, "en")]
    // Garbage / malformed.
    [InlineData(";;;", "en")]
    [InlineData("q=0.5", "en")]
    [InlineData("123abc", "en")]
    public void Normalise_Returns_Whitelist_Member_Or_Default(
        string? header, string expected)
    {
        Assert.Equal(expected, LanguageNormalizer.Normalise(header));
    }

    [Fact]
    public void Default_Language_Is_English()
    {
        // Pinned constant — frontend, .NET, and Python all agree on "en"
        // as the fallback. Changing this drifts the three sides apart.
        Assert.Equal("en", LanguageNormalizer.DefaultLanguage);
    }
}
