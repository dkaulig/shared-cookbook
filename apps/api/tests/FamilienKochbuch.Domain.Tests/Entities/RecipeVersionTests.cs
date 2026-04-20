using FamilienKochbuch.Domain.Common;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.Enums;
using Xunit;

namespace FamilienKochbuch.Domain.Tests.Entities;

/// <summary>
/// OFF3: asserts <see cref="Recipe"/> implements
/// <see cref="IVersionedEntity"/> and every public mutation method
/// bumps <see cref="Recipe.Version"/> exactly once. Mirrors the
/// MealPlan P3-9 version-bump test pattern.
/// </summary>
public class RecipeVersionTests
{
    private static Recipe NewRecipe() => new(
        groupId: Guid.NewGuid(),
        createdByUserId: Guid.NewGuid(),
        title: "Spätzle",
        description: null,
        defaultServings: 4,
        prepTimeMinutes: null,
        difficulty: 1,
        sourceUrl: null,
        sourceType: RecipeSourceType.Manual,
        forkOfRecipeId: null,
        createdAt: DateTimeOffset.UtcNow);

    [Fact]
    public void Implements_IVersionedEntity()
    {
        Assert.IsAssignableFrom<IVersionedEntity>(NewRecipe());
    }

    [Fact]
    public void Constructor_Initialises_Version_To_Zero()
    {
        Assert.Equal(0, NewRecipe().Version);
    }

    [Fact]
    public void UpdateMetadata_Bumps_Version_Once()
    {
        var r = NewRecipe();
        var before = r.Version;

        r.UpdateMetadata(
            title: "Linsen-Curry",
            description: null,
            defaultServings: 2,
            prepTimeMinutes: 30,
            difficulty: 2,
            sourceUrl: null,
            sourceType: RecipeSourceType.Manual,
            updatedAt: DateTimeOffset.UtcNow);

        Assert.Equal(before + 1, r.Version);
    }

    [Fact]
    public void AddPhoto_Bumps_Version_Once()
    {
        var r = NewRecipe();
        var before = r.Version;

        r.AddPhoto("recipes/a.jpg");

        Assert.Equal(before + 1, r.Version);
    }

    [Fact]
    public void RemovePhoto_Bumps_Version_When_Removed()
    {
        var r = NewRecipe();
        r.AddPhoto("recipes/a.jpg");
        var before = r.Version;

        var removed = r.RemovePhoto("recipes/a.jpg");

        Assert.True(removed);
        Assert.Equal(before + 1, r.Version);
    }

    [Fact]
    public void RemovePhoto_Does_Not_Bump_When_Nothing_Removed()
    {
        var r = NewRecipe();
        var before = r.Version;

        var removed = r.RemovePhoto("recipes/does-not-exist.jpg");

        Assert.False(removed);
        Assert.Equal(before, r.Version);
    }

    [Fact]
    public void MarkCooked_Bumps_Version_Once()
    {
        var r = NewRecipe();
        var before = r.Version;

        r.MarkCooked(DateTimeOffset.UtcNow);

        Assert.Equal(before + 1, r.Version);
    }

    [Fact]
    public void SoftDelete_Bumps_Version_Once()
    {
        var r = NewRecipe();
        var before = r.Version;

        r.SoftDelete(DateTimeOffset.UtcNow);

        Assert.Equal(before + 1, r.Version);
    }

    [Fact]
    public void SetNutritionEstimate_Bumps_Version_Once()
    {
        var r = NewRecipe();
        var before = r.Version;

        r.SetNutritionEstimate(new NutritionEstimate(500, 20, 40, 15), DateTimeOffset.UtcNow);

        Assert.Equal(before + 1, r.Version);
    }

    [Fact]
    public void Multiple_Mutations_Accumulate()
    {
        var r = NewRecipe();

        r.AddPhoto("recipes/a.jpg");
        r.MarkCooked(DateTimeOffset.UtcNow);
        r.SetNutritionEstimate(null, DateTimeOffset.UtcNow);

        Assert.Equal(3, r.Version);
    }
}
