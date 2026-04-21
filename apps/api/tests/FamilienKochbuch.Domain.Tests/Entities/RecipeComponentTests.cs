using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.Enums;
using Xunit;

namespace FamilienKochbuch.Domain.Tests.Entities;

/// <summary>
/// COMP-0 — invariants for the new <see cref="RecipeComponent"/> aggregate
/// member plus the <see cref="Recipe.ReplaceComponents"/> rules that
/// enforce "≥ 1 component", unique positions, and cross-recipe FK guards.
/// See <c>docs/plans/2026-04-21-recipe-components-design.md</c>.
/// </summary>
public class RecipeComponentTests
{
    private static Recipe NewRecipe()
    {
        return new Recipe(
            groupId: Guid.NewGuid(),
            createdByUserId: Guid.NewGuid(),
            title: "Quesadillas",
            description: null,
            defaultServings: 4,
            prepTimeMinutes: null,
            difficulty: 1,
            sourceUrl: null,
            sourceType: RecipeSourceType.Manual,
            forkOfRecipeId: null,
            createdAt: DateTimeOffset.UtcNow);
    }

    [Fact]
    public void RecipeComponent_Rejects_Empty_RecipeId()
    {
        Assert.Throws<ArgumentException>(() =>
            new RecipeComponent(Guid.Empty, 0, null));
    }

    [Fact]
    public void RecipeComponent_Rejects_Negative_Position()
    {
        Assert.Throws<ArgumentException>(() =>
            new RecipeComponent(Guid.NewGuid(), -1, null));
    }

    [Fact]
    public void RecipeComponent_Accepts_Null_Label_As_Default()
    {
        var recipeId = Guid.NewGuid();
        var component = new RecipeComponent(recipeId, 0, null);

        Assert.Equal(recipeId, component.RecipeId);
        Assert.Equal(0, component.Position);
        Assert.Null(component.Label);
    }

    [Fact]
    public void RecipeComponent_Trims_Label()
    {
        var component = new RecipeComponent(Guid.NewGuid(), 1, "  Chipotle Sauce  ");
        Assert.Equal("Chipotle Sauce", component.Label);
    }

    [Fact]
    public void RecipeComponent_Normalizes_Blank_Label_To_Null()
    {
        var component = new RecipeComponent(Guid.NewGuid(), 0, "   ");
        Assert.Null(component.Label);
    }

    [Fact]
    public void RecipeComponent_Rejects_Label_Longer_Than_120_Chars()
    {
        var tooLong = new string('x', 121);
        Assert.Throws<ArgumentException>(() =>
            new RecipeComponent(Guid.NewGuid(), 0, tooLong));
    }

    // ── Recipe.ReplaceComponents invariants ─────────────────────────

    [Fact]
    public void ReplaceComponents_Rejects_Empty_Set()
    {
        var recipe = NewRecipe();

        var ex = Assert.Throws<ArgumentException>(() =>
            recipe.ReplaceComponents(
                Array.Empty<RecipeComponent>(),
                Array.Empty<Ingredient>(),
                Array.Empty<RecipeStep>()));
        Assert.Contains("at least one", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ReplaceComponents_Rejects_Duplicate_Positions()
    {
        var recipe = NewRecipe();
        var a = new RecipeComponent(recipe.Id, 0, "A");
        var b = new RecipeComponent(recipe.Id, 0, "B"); // duplicate position

        Assert.Throws<ArgumentException>(() =>
            recipe.ReplaceComponents(
                new[] { a, b },
                Array.Empty<Ingredient>(),
                Array.Empty<RecipeStep>()));
    }

    [Fact]
    public void ReplaceComponents_Rejects_Component_From_Foreign_Recipe()
    {
        var recipe = NewRecipe();
        var foreign = new RecipeComponent(Guid.NewGuid(), 0, null);

        Assert.Throws<ArgumentException>(() =>
            recipe.ReplaceComponents(
                new[] { foreign },
                Array.Empty<Ingredient>(),
                Array.Empty<RecipeStep>()));
    }

    [Fact]
    public void ReplaceComponents_Rejects_Ingredient_Referencing_Foreign_Component()
    {
        var recipe = NewRecipe();
        var main = new RecipeComponent(recipe.Id, 0, null);
        var foreignComponentId = Guid.NewGuid();
        var ingredient = new Ingredient(
            recipeId: recipe.Id,
            componentId: foreignComponentId,
            position: 0,
            quantity: 500m,
            unit: "g",
            name: "Mehl",
            note: null,
            scalable: true);

        var ex = Assert.Throws<ArgumentException>(() =>
            recipe.ReplaceComponents(
                new[] { main },
                new[] { ingredient },
                Array.Empty<RecipeStep>()));
        Assert.Contains("unknown component", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ReplaceComponents_Rejects_Step_Referencing_Foreign_Component()
    {
        var recipe = NewRecipe();
        var main = new RecipeComponent(recipe.Id, 0, null);
        var foreignComponentId = Guid.NewGuid();
        var step = new RecipeStep(
            recipeId: recipe.Id,
            componentId: foreignComponentId,
            position: 0,
            content: "Hack.");

        Assert.Throws<ArgumentException>(() =>
            recipe.ReplaceComponents(
                new[] { main },
                Array.Empty<Ingredient>(),
                new[] { step }));
    }

    [Fact]
    public void ReplaceComponents_Rejects_Ingredient_From_Foreign_Recipe()
    {
        var recipe = NewRecipe();
        var main = new RecipeComponent(recipe.Id, 0, null);
        var foreignRecipeId = Guid.NewGuid();
        var ingredient = new Ingredient(
            recipeId: foreignRecipeId,
            componentId: main.Id,
            position: 0,
            quantity: 500m,
            unit: "g",
            name: "Mehl",
            note: null,
            scalable: true);

        Assert.Throws<ArgumentException>(() =>
            recipe.ReplaceComponents(
                new[] { main },
                new[] { ingredient },
                Array.Empty<RecipeStep>()));
    }

    [Fact]
    public void ReplaceComponents_Rejects_Step_From_Foreign_Recipe()
    {
        var recipe = NewRecipe();
        var main = new RecipeComponent(recipe.Id, 0, null);
        var foreignRecipeId = Guid.NewGuid();
        var step = new RecipeStep(
            recipeId: foreignRecipeId,
            componentId: main.Id,
            position: 0,
            content: "Hack.");

        Assert.Throws<ArgumentException>(() =>
            recipe.ReplaceComponents(
                new[] { main },
                Array.Empty<Ingredient>(),
                new[] { step }));
    }

    [Fact]
    public void ReplaceComponents_Accepts_Single_Default_Component()
    {
        var recipe = NewRecipe();
        var main = new RecipeComponent(recipe.Id, 0, null);
        var ingredient = new Ingredient(
            recipeId: recipe.Id,
            componentId: main.Id,
            position: 0,
            quantity: 500m,
            unit: "g",
            name: "Mehl",
            note: null,
            scalable: true);
        var step = new RecipeStep(recipe.Id, main.Id, 0, "Mischen.");

        recipe.ReplaceComponents(new[] { main }, new[] { ingredient }, new[] { step });

        Assert.Single(recipe.Components);
        Assert.Single(recipe.Ingredients);
        Assert.Single(recipe.Steps);
    }

    [Fact]
    public void ReplaceComponents_Accepts_Two_Components_With_Distinct_Positions()
    {
        var recipe = NewRecipe();
        var main = new RecipeComponent(recipe.Id, 0, "Hauptgericht");
        var sauce = new RecipeComponent(recipe.Id, 1, "Chipotle Sauce");

        var mainIngredient = new Ingredient(recipe.Id, main.Id, 0, 500m, "g", "Hähnchen", null, true);
        var sauceIngredient = new Ingredient(recipe.Id, sauce.Id, 0, 50m, "g", "Chipotle", null, true);
        var mainStep = new RecipeStep(recipe.Id, main.Id, 0, "Hähnchen anbraten.");
        var sauceStep = new RecipeStep(recipe.Id, sauce.Id, 0, "Sauce pürieren.");

        recipe.ReplaceComponents(
            new[] { main, sauce },
            new[] { mainIngredient, sauceIngredient },
            new[] { mainStep, sauceStep });

        Assert.Equal(2, recipe.Components.Count);
        Assert.Equal(2, recipe.Ingredients.Count);
        Assert.Equal(2, recipe.Steps.Count);
    }

    [Fact]
    public void ReplaceComponents_Replaces_Previous_Set()
    {
        var recipe = NewRecipe();
        // First pass — one component + one ingredient.
        var first = new RecipeComponent(recipe.Id, 0, null);
        var firstIng = new Ingredient(recipe.Id, first.Id, 0, 200m, "g", "Zucker", null, true);
        recipe.ReplaceComponents(new[] { first }, new[] { firstIng }, Array.Empty<RecipeStep>());

        // Second pass — two fresh components. The previous ingredient
        // goes away because its component no longer exists.
        var a = new RecipeComponent(recipe.Id, 0, "Teig");
        var b = new RecipeComponent(recipe.Id, 1, "Füllung");
        var aIng = new Ingredient(recipe.Id, a.Id, 0, 500m, "g", "Mehl", null, true);
        var bIng = new Ingredient(recipe.Id, b.Id, 0, 3m, "", "Eier", null, true);
        recipe.ReplaceComponents(
            new[] { a, b },
            new[] { aIng, bIng },
            Array.Empty<RecipeStep>());

        Assert.Equal(2, recipe.Components.Count);
        Assert.Equal(2, recipe.Ingredients.Count);
        Assert.DoesNotContain(recipe.Ingredients, i => i.Name == "Zucker");
    }
}
