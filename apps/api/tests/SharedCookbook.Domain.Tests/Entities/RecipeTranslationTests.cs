using SharedCookbook.Domain.Entities;
using Xunit;

namespace SharedCookbook.Domain.Tests.Entities;

/// <summary>
/// LANG-2 — invariants for the <see cref="RecipeTranslation"/> entity.
/// Mirrors the design-doc rules: ctor requires non-empty payload, valid
/// language; <c>MarkStale</c> is idempotent; <c>Refresh</c> bumps
/// <c>UpdatedAt</c> and clears the stale flag.
/// </summary>
public class RecipeTranslationTests
{
    private const string SamplePayload = "{\"title\":\"Spaetzle\"}";

    [Fact]
    public void Constructor_Sets_Defaults_And_Is_Not_Stale()
    {
        var recipeId = Guid.NewGuid();
        var now = DateTimeOffset.UtcNow;

        var t = new RecipeTranslation(recipeId, "en", SamplePayload, now);

        Assert.NotEqual(Guid.Empty, t.Id);
        Assert.Equal(recipeId, t.RecipeId);
        Assert.Equal("en", t.Language);
        Assert.Equal(SamplePayload, t.TranslatedPayload);
        Assert.Equal(now, t.UpdatedAt);
        Assert.False(t.IsStale);
    }

    [Theory]
    [InlineData("de")]
    [InlineData("en")]
    [InlineData("DE")]
    [InlineData(" en ")]
    public void Constructor_Normalises_Language(string raw)
    {
        var t = new RecipeTranslation(
            Guid.NewGuid(), raw, SamplePayload, DateTimeOffset.UtcNow);
        Assert.Equal(raw.Trim().ToLowerInvariant(), t.Language);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("xx")]
    [InlineData("fr")]
    public void Constructor_Rejects_Invalid_Language(string lang)
    {
        Assert.Throws<ArgumentException>(() => new RecipeTranslation(
            Guid.NewGuid(), lang, SamplePayload, DateTimeOffset.UtcNow));
    }

    [Fact]
    public void Constructor_Rejects_Empty_RecipeId()
    {
        Assert.Throws<ArgumentException>(() => new RecipeTranslation(
            Guid.Empty, "en", SamplePayload, DateTimeOffset.UtcNow));
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void Constructor_Rejects_Blank_Payload(string payload)
    {
        Assert.Throws<ArgumentException>(() => new RecipeTranslation(
            Guid.NewGuid(), "en", payload, DateTimeOffset.UtcNow));
    }

    [Fact]
    public void MarkStale_Sets_IsStale_True()
    {
        var t = new RecipeTranslation(
            Guid.NewGuid(), "en", SamplePayload, DateTimeOffset.UtcNow);

        t.MarkStale();

        Assert.True(t.IsStale);
    }

    [Fact]
    public void MarkStale_Is_Idempotent()
    {
        var t = new RecipeTranslation(
            Guid.NewGuid(), "en", SamplePayload, DateTimeOffset.UtcNow);

        t.MarkStale();
        t.MarkStale();

        Assert.True(t.IsStale);
    }

    [Fact]
    public void Refresh_Replaces_Payload_And_Clears_Stale()
    {
        var initial = DateTimeOffset.UtcNow;
        var t = new RecipeTranslation(Guid.NewGuid(), "en", SamplePayload, initial);
        t.MarkStale();

        var later = initial.AddMinutes(5);
        var freshPayload = "{\"title\":\"Updated Title\"}";
        t.Refresh(freshPayload, later);

        Assert.Equal(freshPayload, t.TranslatedPayload);
        Assert.Equal(later, t.UpdatedAt);
        Assert.False(t.IsStale);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void Refresh_Rejects_Blank_Payload(string payload)
    {
        var t = new RecipeTranslation(
            Guid.NewGuid(), "en", SamplePayload, DateTimeOffset.UtcNow);

        Assert.Throws<ArgumentException>(() => t.Refresh(payload, DateTimeOffset.UtcNow));
    }
}
