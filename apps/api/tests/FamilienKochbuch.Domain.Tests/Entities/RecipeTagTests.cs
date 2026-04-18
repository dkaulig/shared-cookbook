using FamilienKochbuch.Domain.Entities;
using Xunit;

namespace FamilienKochbuch.Domain.Tests.Entities;

/// <summary>
/// Invariants for the <see cref="RecipeTag"/> join record. Composite PK on
/// (RecipeId, TagId) is enforced by the EF configuration; the domain ensures
/// both ids are present.
/// </summary>
public class RecipeTagTests
{
    [Fact]
    public void Constructor_Sets_Both_Ids()
    {
        var recipeId = Guid.NewGuid();
        var tagId = Guid.NewGuid();

        var link = new RecipeTag(recipeId, tagId);

        Assert.Equal(recipeId, link.RecipeId);
        Assert.Equal(tagId, link.TagId);
    }

    [Fact]
    public void Constructor_Rejects_Empty_RecipeId()
    {
        Assert.Throws<ArgumentException>(() => new RecipeTag(Guid.Empty, Guid.NewGuid()));
    }

    [Fact]
    public void Constructor_Rejects_Empty_TagId()
    {
        Assert.Throws<ArgumentException>(() => new RecipeTag(Guid.NewGuid(), Guid.Empty));
    }
}
