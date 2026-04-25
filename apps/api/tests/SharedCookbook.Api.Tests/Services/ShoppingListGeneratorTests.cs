using SharedCookbook.Api.Services;
using SharedCookbook.Domain.Entities;
using SharedCookbook.Domain.Enums;
using SharedCookbook.Domain.MealPlanning;
using Xunit;

namespace SharedCookbook.Api.Tests.Services;

/// <summary>
/// Tests for the P3-5 <see cref="ShoppingListGenerator"/>. This is the
/// algorithmic hot spot of Phase 3: leftover-slot filter, merge-by-
/// name+unit, carryover, sort, SortOrder spacing. Every branch has a
/// dedicated Fact.
/// </summary>
public class ShoppingListGeneratorTests
{
    private static readonly DateOnly Monday = new(2026, 4, 20);
    private static readonly DateTimeOffset Anchor = new(2026, 4, 20, 10, 0, 0, TimeSpan.Zero);

    // ── Fixture helpers ────────────────────────────────────────────

    private static Recipe BuildRecipe(
        string title,
        int defaultServings,
        params (decimal? qty, string unit, string name)[] ingredients)
    {
        var recipe = new Recipe(
            groupId: Guid.NewGuid(),
            createdByUserId: Guid.NewGuid(),
            title: title,
            description: null,
            defaultServings: defaultServings,
            prepTimeMinutes: 30,
            difficulty: 1,
            sourceUrl: null,
            sourceType: RecipeSourceType.Manual,
            forkOfRecipeId: null,
            createdAt: Anchor);
        // COMP-0 — every ingredient belongs to a component. Build a
        // single default component and anchor the test ingredients on it.
        var defaultComponent = new RecipeComponent(recipe.Id, 0, null);
        var components = new[] { defaultComponent };
        var materializedIngredients = new List<Ingredient>();
        for (var i = 0; i < ingredients.Length; i++)
        {
            var (qty, unit, name) = ingredients[i];
            var scalable = qty.HasValue && qty.Value > 0m;
            materializedIngredients.Add(new Ingredient(
                recipeId: recipe.Id,
                componentId: defaultComponent.Id,
                position: i,
                quantity: qty,
                unit: unit,
                name: name,
                note: null,
                scalable: scalable));
        }
        recipe.ReplaceComponents(components, materializedIngredients, Array.Empty<RecipeStep>());
        return recipe;
    }

    private static MealPlan BuildPlan() => new(Guid.NewGuid(), Monday, Anchor);

    private static MealPlanSlot AddSlot(
        MealPlan plan,
        Guid? recipeId,
        int servings,
        DateOnly? date = null,
        string? label = null,
        Guid? parentSlotId = null)
    {
        var slot = new MealPlanSlot(
            mealPlanId: plan.Id,
            weekStart: plan.WeekStart,
            date: date ?? plan.WeekStart,
            meal: MealSlot.Mittag,
            servings: servings,
            recipeId: recipeId,
            label: label ?? (recipeId is null ? "Label" : null),
            sortOrder: 0,
            createdAt: Anchor);
        if (parentSlotId is { } pid)
        {
            // Locate the parent in the plan to feed SetParent — the
            // in-memory graph is enough for generator tests.
            var parent = plan.Slots.FirstOrDefault(s => s.Id == pid);
            if (parent is null)
                throw new InvalidOperationException("Parent slot must already be on the plan.");
            slot.SetParent(parent, Anchor);
        }
        plan.Slots.Add(slot);
        return slot;
    }

    private static Dictionary<Guid, Recipe> RecipeMap(params Recipe[] rs) =>
        rs.ToDictionary(r => r.Id);

    // ── Basic aggregation ──────────────────────────────────────────

    [Fact]
    public void Empty_Plan_Returns_Empty_List()
    {
        var plan = BuildPlan();
        var result = ShoppingListGenerator.Generate(plan, new Dictionary<Guid, Recipe>());
        Assert.Empty(result);
    }

    [Fact]
    public void Single_Slot_Emits_Scaled_Ingredients()
    {
        var recipe = BuildRecipe("Pasta", 2,
            (200m, "g", "Spaghetti"),
            (2m, "Stück", "Knoblauchzehen"));
        var plan = BuildPlan();
        AddSlot(plan, recipe.Id, servings: 4); // scale = 2

        var result = ShoppingListGenerator.Generate(plan, RecipeMap(recipe));

        Assert.Equal(2, result.Count);
        var spaghetti = result.Single(r => r.Name == "Spaghetti");
        Assert.Equal("400", spaghetti.Quantity);
        Assert.Equal("g", spaghetti.Unit);
        var garlic = result.Single(r => r.Name == "Knoblauchzehen");
        Assert.Equal("4", garlic.Quantity);
    }

    [Fact]
    public void Same_Ingredient_Across_Two_Slots_Gets_Summed()
    {
        var recipe = BuildRecipe("Pasta", 2, (200m, "g", "Spaghetti"));
        var plan = BuildPlan();
        AddSlot(plan, recipe.Id, servings: 2);
        AddSlot(plan, recipe.Id, servings: 2, date: Monday.AddDays(1));

        var result = ShoppingListGenerator.Generate(plan, RecipeMap(recipe));

        var spaghetti = Assert.Single(result);
        Assert.Equal("400", spaghetti.Quantity);
        Assert.Equal("g", spaghetti.Unit);
    }

    [Fact]
    public void Two_Slots_Same_Recipe_Doubled_Servings_Produces_Doubled_Quantity()
    {
        var recipe = BuildRecipe("Curry", 2, (100m, "g", "Linsen"));
        var plan = BuildPlan();
        AddSlot(plan, recipe.Id, servings: 2);                              // scale 1x
        AddSlot(plan, recipe.Id, servings: 2, date: Monday.AddDays(1));     // scale 1x

        var result = ShoppingListGenerator.Generate(plan, RecipeMap(recipe));

        var linsen = Assert.Single(result);
        Assert.Equal("200", linsen.Quantity);
    }

    [Fact]
    public void Different_Unit_Creates_Separate_Rows()
    {
        // "Milch" in ml and "Milch" in Packung should NOT merge — we
        // don't unit-convert.
        var r1 = BuildRecipe("Pfannkuchen", 2, (250m, "ml", "Milch"));
        var r2 = BuildRecipe("Müsli", 1, (1m, "Packung", "Milch"));
        var plan = BuildPlan();
        AddSlot(plan, r1.Id, servings: 2);
        AddSlot(plan, r2.Id, servings: 1, date: Monday.AddDays(1));

        var result = ShoppingListGenerator.Generate(plan, RecipeMap(r1, r2));

        Assert.Equal(2, result.Count);
        Assert.Contains(result, r => r.Unit == "ml");
        Assert.Contains(result, r => r.Unit == "Packung");
    }

    [Fact]
    public void Case_Insensitive_Name_Match_Merges()
    {
        var r1 = BuildRecipe("A", 1, (1m, "g", "tomate"));
        var r2 = BuildRecipe("B", 1, (2m, "g", "Tomate"));
        var plan = BuildPlan();
        AddSlot(plan, r1.Id, servings: 1);
        AddSlot(plan, r2.Id, servings: 1, date: Monday.AddDays(1));

        var result = ShoppingListGenerator.Generate(plan, RecipeMap(r1, r2));

        var merged = Assert.Single(result);
        Assert.Equal("3", merged.Quantity);
        // Unit preserved from first occurrence — plan §P3-5 step 4.
    }

    // ── Leftover-slot filter (MANDATORY per plan §Anti-shortcut) ──

    [Fact]
    public void Leftover_Slot_Ingredients_Are_Not_Counted()
    {
        // Sunday meal-prep: Linsen-Curry × 4 (parent, 4× recipe scale)
        // Monday-reheat: Linsen-Curry × 1 (leftover — must be skipped)
        var recipe = BuildRecipe("Linsen-Curry", 2, (100m, "g", "Linsen"));
        var plan = BuildPlan();
        var parent = AddSlot(plan, recipe.Id, servings: 4, date: Monday);    // scale 2x → 200g
        AddSlot(plan, recipe.Id, servings: 1,
            date: Monday.AddDays(1), parentSlotId: parent.Id);               // should be skipped

        var result = ShoppingListGenerator.Generate(plan, RecipeMap(recipe));

        var linsen = Assert.Single(result);
        // 200g from the parent only; the leftover's 50g is NOT added.
        Assert.Equal("200", linsen.Quantity);
    }

    [Fact]
    public void Freeform_Label_Slot_Without_Recipe_Is_Skipped()
    {
        var recipe = BuildRecipe("Pizza", 2, (1m, "Stück", "Teig"));
        var plan = BuildPlan();
        AddSlot(plan, recipe.Id, servings: 2);
        AddSlot(plan, recipeId: null, servings: 2,
            date: Monday.AddDays(1), label: "Pizza bestellen");

        var result = ShoppingListGenerator.Generate(plan, RecipeMap(recipe));

        // Only the real recipe contributes; the freeform slot brings nothing.
        var teig = Assert.Single(result);
        Assert.Equal("1", teig.Quantity);
    }

    [Fact]
    public void Slot_Whose_Recipe_Is_Missing_From_Map_Is_Skipped()
    {
        var recipe = BuildRecipe("Known", 2, (1m, "g", "Salz"));
        var plan = BuildPlan();
        AddSlot(plan, recipe.Id, servings: 2);
        AddSlot(plan, Guid.NewGuid(), servings: 2, date: Monday.AddDays(1)); // unknown recipe id

        var result = ShoppingListGenerator.Generate(plan, RecipeMap(recipe));

        // Only the known recipe contributes.
        var salz = Assert.Single(result);
        Assert.Equal("Salz", salz.Name);
    }

    // ── Quantity edge-cases ────────────────────────────────────────

    [Fact]
    public void Null_Quantity_Ingredient_Is_Preserved_With_Empty_Quantity()
    {
        // "Salz nach Geschmack" — quantity null, scalable false.
        var recipe = BuildRecipe("X", 2, (null, "", "Salz"));
        var plan = BuildPlan();
        AddSlot(plan, recipe.Id, servings: 2);

        var result = ShoppingListGenerator.Generate(plan, RecipeMap(recipe));

        var salz = Assert.Single(result);
        Assert.Null(salz.Quantity);
        Assert.Null(salz.Unit);
    }

    [Fact]
    public void Scaled_Quantity_Uses_Invariant_Decimal_Formatting()
    {
        // 100g × (3/2) = 150g (integral, trailing zeros trimmed)
        var recipe = BuildRecipe("X", 2, (100m, "g", "Mehl"));
        var plan = BuildPlan();
        AddSlot(plan, recipe.Id, servings: 3);

        var result = ShoppingListGenerator.Generate(plan, RecipeMap(recipe));

        Assert.Equal("150", Assert.Single(result).Quantity);
    }

    [Fact]
    public void Fractional_Scaling_Preserves_Precision()
    {
        // 200g ÷ 4 servings × 3 servings = 150g.
        var recipe = BuildRecipe("X", 4, (200m, "g", "Butter"));
        var plan = BuildPlan();
        AddSlot(plan, recipe.Id, servings: 3);

        var result = ShoppingListGenerator.Generate(plan, RecipeMap(recipe));

        Assert.Equal("150", Assert.Single(result).Quantity);
    }

    // ── Carryover ──────────────────────────────────────────────────

    [Fact]
    public void Carryover_Adds_Previous_Week_Unchecked_Items()
    {
        var plan = BuildPlan();
        var carryover = new[]
        {
            new ShoppingListGenerator.CarryoverCandidate(
                Name: "Avocado",
                Quantity: "2",
                Unit: "Stück",
                Note: null,
                Category: IngredientCategory.Sonstiges,
                Source: ShoppingListItemSource.FromPlan,
                IsChecked: false),
        };

        var result = ShoppingListGenerator.Generate(
            plan, new Dictionary<Guid, Recipe>(), carryover);

        var avo = Assert.Single(result);
        Assert.Equal("Avocado", avo.Name);
        Assert.Equal("2", avo.Quantity);
        Assert.True(avo.CarriedOverFromPreviousWeek);
        Assert.Equal(ShoppingListItemSource.CarriedOver, avo.Source);
    }

    [Fact]
    public void Carryover_Skips_Checked_Items()
    {
        var plan = BuildPlan();
        var carryover = new[]
        {
            new ShoppingListGenerator.CarryoverCandidate(
                Name: "Tomate",
                Quantity: "1",
                Unit: "kg",
                Note: null,
                Category: IngredientCategory.Sonstiges,
                Source: ShoppingListItemSource.FromPlan,
                IsChecked: true),   // already bought — DO NOT carry over
        };

        var result = ShoppingListGenerator.Generate(
            plan, new Dictionary<Guid, Recipe>(), carryover);

        Assert.Empty(result);
    }

    [Fact]
    public void Carryover_Skips_Manual_Source_Items()
    {
        // User typed "Klopapier" manually last week; it's week-
        // specific and should not travel forward.
        var plan = BuildPlan();
        var carryover = new[]
        {
            new ShoppingListGenerator.CarryoverCandidate(
                Name: "Klopapier",
                Quantity: "1",
                Unit: "Packung",
                Note: null,
                Category: IngredientCategory.Sonstiges,
                Source: ShoppingListItemSource.Manual,
                IsChecked: false),
        };

        var result = ShoppingListGenerator.Generate(
            plan, new Dictionary<Guid, Recipe>(), carryover);

        Assert.Empty(result);
    }

    [Fact]
    public void Carryover_Merges_With_Same_Ingredient_From_Plan()
    {
        var recipe = BuildRecipe("Salat", 2, (1m, "Stück", "Tomate"));
        var plan = BuildPlan();
        AddSlot(plan, recipe.Id, servings: 2);

        var carryover = new[]
        {
            new ShoppingListGenerator.CarryoverCandidate(
                Name: "Tomate",
                Quantity: "2",
                Unit: "Stück",
                Note: null,
                Category: IngredientCategory.Sonstiges,
                Source: ShoppingListItemSource.FromPlan,
                IsChecked: false),
        };

        var result = ShoppingListGenerator.Generate(plan, RecipeMap(recipe), carryover);

        var tomate = Assert.Single(result);
        Assert.Equal("3", tomate.Quantity);              // 1 + 2 summed
        Assert.True(tomate.CarriedOverFromPreviousWeek); // flag travels through merge
        Assert.Equal(ShoppingListItemSource.CarriedOver, tomate.Source);
    }

    [Fact]
    public void Carryover_From_Previous_CarriedOver_Still_Skips_When_Checked()
    {
        // User may have the same item twice in history (week N-2 → N-1 → N).
        // Checked at any point means dropped from the chain.
        var plan = BuildPlan();
        var carryover = new[]
        {
            new ShoppingListGenerator.CarryoverCandidate(
                Name: "Zwiebel",
                Quantity: "3",
                Unit: "Stück",
                Note: null,
                Category: IngredientCategory.Sonstiges,
                Source: ShoppingListItemSource.CarriedOver,
                IsChecked: true),
        };

        var result = ShoppingListGenerator.Generate(
            plan, new Dictionary<Guid, Recipe>(), carryover);

        Assert.Empty(result);
    }

    [Fact]
    public void Carryover_Without_Candidates_Parameter_Does_Nothing()
    {
        var recipe = BuildRecipe("X", 2, (1m, "g", "Salz"));
        var plan = BuildPlan();
        AddSlot(plan, recipe.Id, servings: 2);

        var result = ShoppingListGenerator.Generate(plan, RecipeMap(recipe)); // no 3rd arg
        Assert.Single(result);
    }

    // ── Sort + SortOrder ──────────────────────────────────────────

    [Fact]
    public void Items_Are_Sorted_By_Name_Within_Category()
    {
        var recipe = BuildRecipe("Salat", 2,
            (1m, "Stück", "Zwiebel"),
            (1m, "Stück", "Apfel"),
            (1m, "Stück", "Birne"));
        var plan = BuildPlan();
        AddSlot(plan, recipe.Id, servings: 2);

        var result = ShoppingListGenerator.Generate(plan, RecipeMap(recipe));

        Assert.Equal(new[] { "Apfel", "Birne", "Zwiebel" },
            result.Select(r => r.Name).ToArray());
    }

    [Fact]
    public void SortOrder_Uses_Spacing_Of_Ten()
    {
        var recipe = BuildRecipe("X", 2,
            (1m, "", "A"), (2m, "", "B"), (3m, "", "C"));
        var plan = BuildPlan();
        AddSlot(plan, recipe.Id, servings: 2);

        var result = ShoppingListGenerator.Generate(plan, RecipeMap(recipe))
            .OrderBy(r => r.SortOrder).ToList();

        Assert.Equal(0, result[0].SortOrder);
        Assert.Equal(10, result[1].SortOrder);
        Assert.Equal(20, result[2].SortOrder);
    }

    [Fact]
    public void Note_From_First_Ingredient_Survives_Merge()
    {
        var r1 = new Recipe(
            groupId: Guid.NewGuid(), createdByUserId: Guid.NewGuid(),
            title: "A", description: null, defaultServings: 2, prepTimeMinutes: 10,
            difficulty: 1, sourceUrl: null, sourceType: RecipeSourceType.Manual,
            forkOfRecipeId: null, createdAt: Anchor);
        var r1DefaultComponent = new RecipeComponent(r1.Id, 0, null);
        var r1Ingredient = new Ingredient(
            r1.Id, r1DefaultComponent.Id, 0, 100m, "g", "Mehl", "Typ 405", scalable: true);
        r1.ReplaceComponents(
            new[] { r1DefaultComponent },
            new[] { r1Ingredient },
            Array.Empty<RecipeStep>());
        var plan = BuildPlan();
        AddSlot(plan, r1.Id, servings: 2);

        var result = ShoppingListGenerator.Generate(plan, RecipeMap(r1));

        Assert.Equal("Typ 405", Assert.Single(result).Note);
    }

    [Fact]
    public void All_Generated_Items_Start_Unchecked_And_FromPlan()
    {
        var recipe = BuildRecipe("X", 2, (1m, "g", "Salz"));
        var plan = BuildPlan();
        AddSlot(plan, recipe.Id, servings: 2);

        var result = ShoppingListGenerator.Generate(plan, RecipeMap(recipe));

        var item = Assert.Single(result);
        Assert.Equal(ShoppingListItemSource.FromPlan, item.Source);
        Assert.False(item.CarriedOverFromPreviousWeek);
    }

    [Fact]
    public void Generator_Rejects_Null_Plan()
    {
        Assert.Throws<ArgumentNullException>(() =>
            ShoppingListGenerator.Generate(null!, new Dictionary<Guid, Recipe>()));
    }

    [Fact]
    public void Generator_Rejects_Null_Recipe_Map()
    {
        Assert.Throws<ArgumentNullException>(() =>
            ShoppingListGenerator.Generate(BuildPlan(), null!));
    }

    // ── P3-6: Categorizer wiring ───────────────────────────────────

    [Fact]
    public void Generator_Assigns_ObstGemuese_Category_For_Known_Vegetable()
    {
        // P3-6 replaced the hardcoded Sonstiges default with a call
        // to the static IngredientCategorizer. "Tomate" is a staple
        // in the map → must come back as ObstGemuese.
        var recipe = BuildRecipe("Salat", 2, (2m, "Stück", "Tomate"));
        var plan = BuildPlan();
        AddSlot(plan, recipe.Id, servings: 2);

        var result = ShoppingListGenerator.Generate(plan, RecipeMap(recipe));

        var tomate = Assert.Single(result);
        Assert.Equal(IngredientCategory.ObstGemuese, tomate.Category);
    }

    [Fact]
    public void Generator_Assigns_FleischFisch_Category_For_Hackfleisch()
    {
        var recipe = BuildRecipe("Bolognese", 2, (500m, "g", "Hackfleisch"));
        var plan = BuildPlan();
        AddSlot(plan, recipe.Id, servings: 2);

        var result = ShoppingListGenerator.Generate(plan, RecipeMap(recipe));

        var hack = Assert.Single(result);
        Assert.Equal(IngredientCategory.FleischFisch, hack.Category);
    }

    [Fact]
    public void Generator_Assigns_Sonstiges_For_Unknown_Ingredient()
    {
        var recipe = BuildRecipe("Exotisch", 2, (1m, "Stück", "Zzxxqq-Fantasiezutat"));
        var plan = BuildPlan();
        AddSlot(plan, recipe.Id, servings: 2);

        var result = ShoppingListGenerator.Generate(plan, RecipeMap(recipe));

        var unknown = Assert.Single(result);
        Assert.Equal(IngredientCategory.Sonstiges, unknown.Category);
    }

    [Fact]
    public void Generator_Groups_Items_By_Real_Category_On_Sort()
    {
        // Two ingredients from different categories should land in
        // different groups with their own SortOrder spacing.
        var recipe = BuildRecipe("Mix", 2,
            (500m, "g", "Hackfleisch"),   // FleischFisch
            (2m, "Stück", "Tomate"));     // ObstGemuese
        var plan = BuildPlan();
        AddSlot(plan, recipe.Id, servings: 2);

        var result = ShoppingListGenerator.Generate(plan, RecipeMap(recipe));

        Assert.Equal(2, result.Count);
        Assert.Contains(result, r => r.Category == IngredientCategory.FleischFisch);
        Assert.Contains(result, r => r.Category == IngredientCategory.ObstGemuese);
        // Each bucket starts at SortOrder 0 (spacing is within bucket).
        Assert.All(result, r => Assert.Equal(0, r.SortOrder));
    }

    [Fact]
    public void Carryover_Preserves_Persisted_Category()
    {
        // Carryover rows keep their stored Category even when the
        // static categorizer would now place them elsewhere — avoids
        // silent reshuffles across week boundaries.
        var plan = BuildPlan();
        var carryover = new[]
        {
            new ShoppingListGenerator.CarryoverCandidate(
                Name: "Avocado",
                Quantity: "2",
                Unit: "Stück",
                // Pretend a previous version stored it as Sonstiges —
                // the generator must NOT upgrade it to ObstGemuese.
                Category: IngredientCategory.Sonstiges,
                Note: null,
                Source: ShoppingListItemSource.FromPlan,
                IsChecked: false),
        };

        var result = ShoppingListGenerator.Generate(
            plan, new Dictionary<Guid, Recipe>(), carryover);

        var avo = Assert.Single(result);
        Assert.Equal(IngredientCategory.Sonstiges, avo.Category);
    }
}
