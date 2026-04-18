using FamilienKochbuch.Domain.Entities;
using Xunit;

namespace FamilienKochbuch.Domain.Tests.Entities;

/// <summary>
/// Invariants for <see cref="RecipeStep"/>. Content is Markdown-ish plain
/// text, 1..5000 chars. Position is 0-based.
/// </summary>
public class RecipeStepTests
{
    [Fact]
    public void Constructor_Sets_Fields()
    {
        var recipeId = Guid.NewGuid();
        var step = new RecipeStep(recipeId, position: 0, content: "Mehl sieben.");

        Assert.NotEqual(Guid.Empty, step.Id);
        Assert.Equal(recipeId, step.RecipeId);
        Assert.Equal(0, step.Position);
        Assert.Equal("Mehl sieben.", step.Content);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData(null)]
    public void Constructor_Rejects_Blank_Content(string? invalid)
    {
        Assert.Throws<ArgumentException>(() =>
            new RecipeStep(Guid.NewGuid(), 0, invalid!));
    }

    [Fact]
    public void Constructor_Rejects_Negative_Position()
    {
        Assert.Throws<ArgumentException>(() =>
            new RecipeStep(Guid.NewGuid(), -1, "Mehl sieben."));
    }

    [Fact]
    public void Constructor_Rejects_Content_Longer_Than_5000_Chars()
    {
        var tooLong = new string('x', 5001);

        Assert.Throws<ArgumentException>(() =>
            new RecipeStep(Guid.NewGuid(), 0, tooLong));
    }

    [Fact]
    public void Constructor_Accepts_Content_At_5000_Chars_Boundary()
    {
        var boundary = new string('x', 5000);

        var step = new RecipeStep(Guid.NewGuid(), 0, boundary);

        Assert.Equal(boundary, step.Content);
    }
}
