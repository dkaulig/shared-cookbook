using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.Enums;
using Xunit;

namespace FamilienKochbuch.Domain.Tests.Entities;

/// <summary>
/// Invariants for the <see cref="Recipe"/> aggregate — the central domain
/// object of Phase 1 S3. Mirrors PRD §4.1 / §8.3 constraints: required title,
/// positive default servings, difficulty 1..3, at most three photos.
/// </summary>
public class RecipeTests
{
    private static Recipe NewRecipe(
        string title = "Spätzle",
        int defaultServings = 4,
        int difficulty = 1)
    {
        return new Recipe(
            groupId: Guid.NewGuid(),
            createdByUserId: Guid.NewGuid(),
            title: title,
            description: null,
            defaultServings: defaultServings,
            prepTimeMinutes: null,
            difficulty: difficulty,
            sourceUrl: null,
            sourceType: RecipeSourceType.Manual,
            forkOfRecipeId: null,
            createdAt: DateTimeOffset.UtcNow);
    }

    [Fact]
    public void Constructor_Sets_Defaults_For_Minimal_Input()
    {
        var now = DateTimeOffset.UtcNow;
        var groupId = Guid.NewGuid();
        var userId = Guid.NewGuid();

        var recipe = new Recipe(
            groupId: groupId,
            createdByUserId: userId,
            title: "Kartoffelsalat",
            description: null,
            defaultServings: 4,
            prepTimeMinutes: null,
            difficulty: 1,
            sourceUrl: null,
            sourceType: RecipeSourceType.Manual,
            forkOfRecipeId: null,
            createdAt: now);

        Assert.NotEqual(Guid.Empty, recipe.Id);
        Assert.Equal(groupId, recipe.GroupId);
        Assert.Equal(userId, recipe.CreatedByUserId);
        Assert.Equal("Kartoffelsalat", recipe.Title);
        Assert.Null(recipe.Description);
        Assert.Equal(4, recipe.DefaultServings);
        Assert.Null(recipe.PrepTimeMinutes);
        Assert.Equal(1, recipe.Difficulty);
        Assert.Null(recipe.SourceUrl);
        Assert.Equal(RecipeSourceType.Manual, recipe.SourceType);
        Assert.Null(recipe.ForkOfRecipeId);
        Assert.Empty(recipe.Photos);
        Assert.Null(recipe.LastCookedAt);
        Assert.Equal(now, recipe.CreatedAt);
        Assert.Equal(now, recipe.UpdatedAt);
        Assert.Null(recipe.DeletedAt);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData(null)]
    public void Constructor_Rejects_Blank_Title(string? invalid)
    {
        Assert.Throws<ArgumentException>(() => NewRecipe(title: invalid!));
    }

    [Fact]
    public void Constructor_Trims_Title()
    {
        var recipe = NewRecipe(title: "  Spätzle  ");

        Assert.Equal("Spätzle", recipe.Title);
    }

    [Fact]
    public void Constructor_Rejects_Title_Longer_Than_200_Chars()
    {
        var tooLong = new string('x', 201);

        Assert.Throws<ArgumentException>(() => NewRecipe(title: tooLong));
    }

    [Fact]
    public void Constructor_Accepts_Title_At_200_Chars_Boundary()
    {
        var boundary = new string('x', 200);

        var recipe = NewRecipe(title: boundary);

        Assert.Equal(boundary, recipe.Title);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public void Constructor_Rejects_Non_Positive_DefaultServings(int invalid)
    {
        Assert.Throws<ArgumentException>(() => NewRecipe(defaultServings: invalid));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(4)]
    [InlineData(-1)]
    public void Constructor_Rejects_Difficulty_Out_Of_Range(int invalid)
    {
        Assert.Throws<ArgumentException>(() => NewRecipe(difficulty: invalid));
    }

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    public void Constructor_Accepts_Difficulty_Within_Range(int allowed)
    {
        var recipe = NewRecipe(difficulty: allowed);

        Assert.Equal(allowed, recipe.Difficulty);
    }

    [Fact]
    public void Constructor_Rejects_Description_Longer_Than_2000_Chars()
    {
        var tooLong = new string('d', 2001);
        Assert.Throws<ArgumentException>(() => new Recipe(
            groupId: Guid.NewGuid(),
            createdByUserId: Guid.NewGuid(),
            title: "ok",
            description: tooLong,
            defaultServings: 4,
            prepTimeMinutes: null,
            difficulty: 1,
            sourceUrl: null,
            sourceType: RecipeSourceType.Manual,
            forkOfRecipeId: null,
            createdAt: DateTimeOffset.UtcNow));
    }

    [Fact]
    public void Constructor_Accepts_Description_At_2000_Chars_Boundary()
    {
        var boundary = new string('d', 2000);
        var recipe = new Recipe(
            groupId: Guid.NewGuid(),
            createdByUserId: Guid.NewGuid(),
            title: "ok",
            description: boundary,
            defaultServings: 4,
            prepTimeMinutes: null,
            difficulty: 1,
            sourceUrl: null,
            sourceType: RecipeSourceType.Manual,
            forkOfRecipeId: null,
            createdAt: DateTimeOffset.UtcNow);

        Assert.Equal(boundary, recipe.Description);
    }

    [Fact]
    public void Constructor_Normalizes_Blank_Description_To_Null()
    {
        var recipe = new Recipe(
            groupId: Guid.NewGuid(),
            createdByUserId: Guid.NewGuid(),
            title: "ok",
            description: "   ",
            defaultServings: 4,
            prepTimeMinutes: null,
            difficulty: 1,
            sourceUrl: null,
            sourceType: RecipeSourceType.Manual,
            forkOfRecipeId: null,
            createdAt: DateTimeOffset.UtcNow);

        Assert.Null(recipe.Description);
    }

    [Fact]
    public void Constructor_Rejects_Negative_PrepTime()
    {
        Assert.Throws<ArgumentException>(() => new Recipe(
            groupId: Guid.NewGuid(),
            createdByUserId: Guid.NewGuid(),
            title: "ok",
            description: null,
            defaultServings: 4,
            prepTimeMinutes: -1,
            difficulty: 1,
            sourceUrl: null,
            sourceType: RecipeSourceType.Manual,
            forkOfRecipeId: null,
            createdAt: DateTimeOffset.UtcNow));
    }

    [Fact]
    public void AddPhoto_Appends_Url()
    {
        var recipe = NewRecipe();

        recipe.AddPhoto("https://example.com/1.jpg");

        Assert.Single(recipe.Photos);
        Assert.Equal("https://example.com/1.jpg", recipe.Photos[0]);
    }

    [Fact]
    public void AddPhoto_Rejects_Fourth_Photo()
    {
        var recipe = NewRecipe();
        recipe.AddPhoto("https://example.com/1.jpg");
        recipe.AddPhoto("https://example.com/2.jpg");
        recipe.AddPhoto("https://example.com/3.jpg");

        Assert.Throws<InvalidOperationException>(() =>
            recipe.AddPhoto("https://example.com/4.jpg"));
    }

    [Fact]
    public void AddPhoto_Rejects_Blank_Url()
    {
        var recipe = NewRecipe();

        Assert.Throws<ArgumentException>(() => recipe.AddPhoto("   "));
    }

    [Fact]
    public void RemovePhoto_Removes_Matching_Url()
    {
        var recipe = NewRecipe();
        recipe.AddPhoto("https://example.com/a.jpg");
        recipe.AddPhoto("https://example.com/b.jpg");

        recipe.RemovePhoto("https://example.com/a.jpg");

        Assert.Single(recipe.Photos);
        Assert.Equal("https://example.com/b.jpg", recipe.Photos[0]);
    }

    [Fact]
    public void SoftDelete_Sets_DeletedAt()
    {
        var recipe = NewRecipe();
        var at = DateTimeOffset.UtcNow.AddMinutes(2);

        recipe.SoftDelete(at);

        Assert.Equal(at, recipe.DeletedAt);
    }

    // ── P2-10 — Nutrition estimate ─────────────────────────────────────

    [Fact]
    public void NutritionEstimate_Is_Null_By_Default()
    {
        var recipe = NewRecipe();

        Assert.Null(recipe.NutritionEstimate);
    }

    [Fact]
    public void SetNutritionEstimate_Stores_All_Four_Fields()
    {
        var recipe = NewRecipe();
        var estimate = new NutritionEstimate(Kcal: 420, ProteinG: 24, CarbsG: 38, FatG: 9);

        recipe.SetNutritionEstimate(estimate, DateTimeOffset.UtcNow);

        Assert.NotNull(recipe.NutritionEstimate);
        Assert.Equal(420, recipe.NutritionEstimate!.Kcal);
        Assert.Equal(24, recipe.NutritionEstimate.ProteinG);
        Assert.Equal(38, recipe.NutritionEstimate.CarbsG);
        Assert.Equal(9, recipe.NutritionEstimate.FatG);
    }

    [Fact]
    public void SetNutritionEstimate_Null_Clears_Existing()
    {
        var recipe = NewRecipe();
        recipe.SetNutritionEstimate(
            new NutritionEstimate(300, 10, 30, 8), DateTimeOffset.UtcNow);

        recipe.SetNutritionEstimate(null, DateTimeOffset.UtcNow);

        Assert.Null(recipe.NutritionEstimate);
    }

    [Fact]
    public void SetNutritionEstimate_Updates_UpdatedAt()
    {
        var recipe = NewRecipe();
        var before = recipe.UpdatedAt;
        var later = DateTimeOffset.UtcNow.AddHours(1);

        recipe.SetNutritionEstimate(
            new NutritionEstimate(300, 10, 30, 8), later);

        Assert.Equal(later, recipe.UpdatedAt);
        Assert.NotEqual(before, recipe.UpdatedAt);
    }

    [Theory]
    [InlineData(-1, 10, 10, 10)]
    [InlineData(5001, 10, 10, 10)]
    [InlineData(100, -1, 10, 10)]
    [InlineData(100, 501, 10, 10)]
    [InlineData(100, 10, 501, 10)]
    [InlineData(100, 10, 10, 501)]
    [InlineData(100, 10, 10, -1)]
    public void NutritionEstimate_Rejects_Out_Of_Range(int kcal, int protein, int carbs, int fat)
    {
        Assert.Throws<ArgumentException>(() =>
            new NutritionEstimate(kcal, protein, carbs, fat));
    }

    [Theory]
    [InlineData(0, 0, 0, 0)]
    [InlineData(5000, 500, 500, 500)]
    [InlineData(420, 24, 38, 9)]
    public void NutritionEstimate_Accepts_Boundary_Values(int kcal, int protein, int carbs, int fat)
    {
        var estimate = new NutritionEstimate(kcal, protein, carbs, fat);
        Assert.Equal(kcal, estimate.Kcal);
        Assert.Equal(protein, estimate.ProteinG);
        Assert.Equal(carbs, estimate.CarbsG);
        Assert.Equal(fat, estimate.FatG);
    }
}
