using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.Enums;
using Xunit;

namespace FamilienKochbuch.Domain.Tests.Entities;

/// <summary>
/// REIMPORT-0 — contract tests for <see cref="Recipe.UpdateFromImport"/>.
///
/// The reimport flow loads the current recipe with its children, parses a
/// fresh extraction result, and calls <c>UpdateFromImport</c> to overwrite
/// the mutable body in place. Preserved: Id, GroupId, CreatedAt,
/// CreatedByUserId, Photos, Ratings, TimesCooked, LastCookedAt,
/// SlotAssignments. Overwritten: Title, Description, DefaultServings,
/// PrepTimeMinutes, Difficulty, Ingredients, Steps, NutritionEstimate.
/// Tags: existing Custom-category tags stay; AI tags (non-Custom) are
/// replaced with the new list, with a Custom-wins rule on name collision.
/// Version bumps exactly once per call.
/// </summary>
public class RecipeUpdateFromImportTests
{
    private static Recipe NewRecipe(
        DateTimeOffset? createdAt = null,
        string? sourceUrl = "https://example.com/original")
    {
        return new Recipe(
            groupId: Guid.NewGuid(),
            createdByUserId: Guid.NewGuid(),
            title: "Altes Rezept",
            description: "Alte Beschreibung",
            defaultServings: 2,
            prepTimeMinutes: 10,
            difficulty: 1,
            sourceUrl: sourceUrl,
            sourceType: RecipeSourceType.Video,
            forkOfRecipeId: null,
            createdAt: createdAt ?? DateTimeOffset.UtcNow);
    }

    private static Ingredient NewIngredient(Guid recipeId, int position, string name, decimal? quantity = 100m, string unit = "g")
    {
        return new Ingredient(
            recipeId: recipeId,
            position: position,
            quantity: quantity,
            unit: unit,
            name: name,
            note: null,
            scalable: quantity.HasValue && quantity.Value > 0m);
    }

    private static RecipeStep NewStep(Guid recipeId, int position, string content)
        => new RecipeStep(recipeId, position, content);

    private static Tag NewCustomTag(string name)
        => Tag.CreateGroupScoped(Guid.NewGuid(), Guid.NewGuid(), name);

    private static Tag NewAiTag(string name)
        // Non-Custom category — AI-suggested tags resolve to global seeded
        // tags (Mahlzeit / Typ / …). We use Typ here as a stand-in; only
        // "category != Custom" matters for the domain method.
        => Tag.CreateGlobal(name, TagCategory.Typ);

    [Fact]
    public void UpdateFromImport_Replaces_Title_Description_And_Numeric_Metadata()
    {
        var recipe = NewRecipe();
        recipe.Ingredients.Add(NewIngredient(recipe.Id, 0, "Alte Zutat"));
        recipe.Steps.Add(NewStep(recipe.Id, 0, "Alter Schritt"));

        var newIng = new List<Ingredient>
        {
            NewIngredient(recipe.Id, 0, "Mehl", 500m, "g"),
            NewIngredient(recipe.Id, 1, "Wasser", 250m, "ml"),
        };
        var newSteps = new List<RecipeStep>
        {
            NewStep(recipe.Id, 0, "Vermengen."),
            NewStep(recipe.Id, 1, "Ruhen lassen."),
        };
        var now = new DateTimeOffset(2026, 4, 21, 12, 0, 0, TimeSpan.Zero);

        recipe.UpdateFromImport(
            title: "Neues Rezept",
            description: "Neue Beschreibung",
            defaultServings: 4,
            prepTimeMinutes: 20,
            cookTimeMinutes: null,
            difficulty: 2,
            newIngredients: newIng,
            newSteps: newSteps,
            newAiTagNames: Array.Empty<string>(),
            existingAndNewTags: Array.Empty<Tag>(),
            nutrition: null,
            now: now);

        Assert.Equal("Neues Rezept", recipe.Title);
        Assert.Equal("Neue Beschreibung", recipe.Description);
        Assert.Equal(4, recipe.DefaultServings);
        Assert.Equal(20, recipe.PrepTimeMinutes);
        Assert.Equal(2, recipe.Difficulty);
        Assert.Equal(2, recipe.Ingredients.Count);
        Assert.Equal(2, recipe.Steps.Count);
        Assert.Equal("Mehl", recipe.Ingredients.OrderBy(i => i.Position).First().Name);
        Assert.Equal("Vermengen.", recipe.Steps.OrderBy(s => s.Position).First().Content);
    }

    [Fact]
    public void UpdateFromImport_Preserves_Photos()
    {
        var recipe = NewRecipe();
        recipe.AddPhoto("recipes/abc.jpg");
        recipe.AddPhoto("recipes/def.jpg");
        var versionBefore = recipe.Version;

        recipe.UpdateFromImport(
            title: "X",
            description: null,
            defaultServings: 4,
            prepTimeMinutes: null,
            cookTimeMinutes: null,
            difficulty: 1,
            newIngredients: Array.Empty<Ingredient>(),
            newSteps: Array.Empty<RecipeStep>(),
            newAiTagNames: Array.Empty<string>(),
            existingAndNewTags: Array.Empty<Tag>(),
            nutrition: null,
            now: DateTimeOffset.UtcNow);

        Assert.Equal(2, recipe.Photos.Count);
        Assert.Equal("recipes/abc.jpg", recipe.Photos[0]);
        Assert.Equal("recipes/def.jpg", recipe.Photos[1]);
        // The two AddPhoto calls bumped Version twice; UpdateFromImport
        // bumps exactly once more on top.
        Assert.Equal(versionBefore + 1, recipe.Version);
    }

    [Fact]
    public void UpdateFromImport_Preserves_LastCookedAt()
    {
        var recipe = NewRecipe();
        var cookedAt = new DateTimeOffset(2026, 4, 10, 18, 0, 0, TimeSpan.Zero);
        recipe.MarkCooked(cookedAt);

        recipe.UpdateFromImport(
            title: "X",
            description: null,
            defaultServings: 4,
            prepTimeMinutes: null,
            cookTimeMinutes: null,
            difficulty: 1,
            newIngredients: Array.Empty<Ingredient>(),
            newSteps: Array.Empty<RecipeStep>(),
            newAiTagNames: Array.Empty<string>(),
            existingAndNewTags: Array.Empty<Tag>(),
            nutrition: null,
            now: DateTimeOffset.UtcNow);

        Assert.Equal(cookedAt, recipe.LastCookedAt);
    }

    [Fact]
    public void UpdateFromImport_Preserves_Id_GroupId_CreatedAt_And_Creator()
    {
        var created = new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
        var recipe = NewRecipe(createdAt: created);
        var origId = recipe.Id;
        var origGroup = recipe.GroupId;
        var origCreator = recipe.CreatedByUserId;

        recipe.UpdateFromImport(
            title: "X",
            description: null,
            defaultServings: 4,
            prepTimeMinutes: null,
            cookTimeMinutes: null,
            difficulty: 1,
            newIngredients: Array.Empty<Ingredient>(),
            newSteps: Array.Empty<RecipeStep>(),
            newAiTagNames: Array.Empty<string>(),
            existingAndNewTags: Array.Empty<Tag>(),
            nutrition: null,
            now: DateTimeOffset.UtcNow);

        Assert.Equal(origId, recipe.Id);
        Assert.Equal(origGroup, recipe.GroupId);
        Assert.Equal(origCreator, recipe.CreatedByUserId);
        Assert.Equal(created, recipe.CreatedAt);
    }

    [Fact]
    public void UpdateFromImport_Keeps_Custom_Tags_And_Replaces_Ai_Tags()
    {
        var recipe = NewRecipe();
        var customTag = NewCustomTag("Lieblingsessen");
        var oldAiTag = NewAiTag("schnell");
        recipe.RecipeTags.Add(new RecipeTag(recipe.Id, customTag.Id));
        recipe.RecipeTags.Add(new RecipeTag(recipe.Id, oldAiTag.Id));

        var newAiTag = NewAiTag("vegetarisch");

        recipe.UpdateFromImport(
            title: "Neu",
            description: null,
            defaultServings: 4,
            prepTimeMinutes: null,
            cookTimeMinutes: null,
            difficulty: 1,
            newIngredients: Array.Empty<Ingredient>(),
            newSteps: Array.Empty<RecipeStep>(),
            newAiTagNames: new[] { "vegetarisch" },
            existingAndNewTags: new[] { customTag, oldAiTag, newAiTag },
            nutrition: null,
            now: DateTimeOffset.UtcNow);

        var tagIds = recipe.RecipeTags.Select(rt => rt.TagId).ToHashSet();
        Assert.Contains(customTag.Id, tagIds);           // preserved
        Assert.DoesNotContain(oldAiTag.Id, tagIds);       // old AI dropped
        Assert.Contains(newAiTag.Id, tagIds);             // new AI added
        Assert.Equal(2, tagIds.Count);
    }

    [Fact]
    public void UpdateFromImport_Skips_AiTag_When_Custom_Tag_With_Same_Name_Exists()
    {
        var recipe = NewRecipe();
        // User had a Custom tag "Komfortfood"; AI now suggests the same
        // name as a generic tag. Domain must keep the Custom one and not
        // add a duplicate AI entry with the same label.
        var customTag = NewCustomTag("komfortfood");
        recipe.RecipeTags.Add(new RecipeTag(recipe.Id, customTag.Id));

        var shadowedAiTag = NewAiTag("komfortfood");

        recipe.UpdateFromImport(
            title: "Neu",
            description: null,
            defaultServings: 4,
            prepTimeMinutes: null,
            cookTimeMinutes: null,
            difficulty: 1,
            newIngredients: Array.Empty<Ingredient>(),
            newSteps: Array.Empty<RecipeStep>(),
            newAiTagNames: new[] { "komfortfood" },
            existingAndNewTags: new[] { customTag, shadowedAiTag },
            nutrition: null,
            now: DateTimeOffset.UtcNow);

        var tagIds = recipe.RecipeTags.Select(rt => rt.TagId).ToList();
        Assert.Single(tagIds);
        Assert.Equal(customTag.Id, tagIds[0]);
    }

    [Fact]
    public void UpdateFromImport_Bumps_Version_Exactly_Once()
    {
        var recipe = NewRecipe();
        var versionBefore = recipe.Version;

        recipe.UpdateFromImport(
            title: "Neu",
            description: null,
            defaultServings: 4,
            prepTimeMinutes: null,
            cookTimeMinutes: null,
            difficulty: 1,
            newIngredients: Array.Empty<Ingredient>(),
            newSteps: Array.Empty<RecipeStep>(),
            newAiTagNames: Array.Empty<string>(),
            existingAndNewTags: Array.Empty<Tag>(),
            nutrition: null,
            now: DateTimeOffset.UtcNow);

        Assert.Equal(versionBefore + 1, recipe.Version);
    }

    [Fact]
    public void UpdateFromImport_Sets_UpdatedAt_To_Passed_Clock()
    {
        var recipe = NewRecipe();
        var now = new DateTimeOffset(2026, 5, 1, 9, 30, 0, TimeSpan.Zero);

        recipe.UpdateFromImport(
            title: "Neu",
            description: null,
            defaultServings: 4,
            prepTimeMinutes: null,
            cookTimeMinutes: null,
            difficulty: 1,
            newIngredients: Array.Empty<Ingredient>(),
            newSteps: Array.Empty<RecipeStep>(),
            newAiTagNames: Array.Empty<string>(),
            existingAndNewTags: Array.Empty<Tag>(),
            nutrition: null,
            now: now);

        Assert.Equal(now, recipe.UpdatedAt);
    }

    [Fact]
    public void UpdateFromImport_With_Zero_Ingredients_And_Steps_Does_Not_Crash()
    {
        var recipe = NewRecipe();
        recipe.Ingredients.Add(NewIngredient(recipe.Id, 0, "Alte Zutat"));
        recipe.Steps.Add(NewStep(recipe.Id, 0, "Alter Schritt"));

        recipe.UpdateFromImport(
            title: "Leer",
            description: null,
            defaultServings: 1,
            prepTimeMinutes: null,
            cookTimeMinutes: null,
            difficulty: 1,
            // no-op overwrite — still must clear children without crashing.
            newIngredients: Array.Empty<Ingredient>(),
            newSteps: Array.Empty<RecipeStep>(),
            newAiTagNames: Array.Empty<string>(),
            existingAndNewTags: Array.Empty<Tag>(),
            nutrition: null,
            now: DateTimeOffset.UtcNow);

        Assert.Empty(recipe.Ingredients);
        Assert.Empty(recipe.Steps);
    }

    [Fact]
    public void UpdateFromImport_Replaces_Nutrition_Estimate()
    {
        var recipe = NewRecipe();
        recipe.SetNutritionEstimate(new NutritionEstimate(200, 5, 20, 3), DateTimeOffset.UtcNow);
        var newEstimate = new NutritionEstimate(450, 22, 40, 12);

        recipe.UpdateFromImport(
            title: "Neu",
            description: null,
            defaultServings: 4,
            prepTimeMinutes: null,
            cookTimeMinutes: null,
            difficulty: 1,
            newIngredients: Array.Empty<Ingredient>(),
            newSteps: Array.Empty<RecipeStep>(),
            newAiTagNames: Array.Empty<string>(),
            existingAndNewTags: Array.Empty<Tag>(),
            nutrition: newEstimate,
            now: DateTimeOffset.UtcNow);

        Assert.Equal(450, recipe.NutritionEstimate!.Kcal);
        Assert.Equal(22, recipe.NutritionEstimate.ProteinG);
    }
}
