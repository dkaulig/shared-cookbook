using FamilienKochbuch.Domain.Entities;
using Xunit;

namespace FamilienKochbuch.Domain.Tests.Entities;

/// <summary>
/// Invariants for the <see cref="Ingredient"/> value. Supports both scaled
/// entries (quantity + scalable=true) and "nach Geschmack" entries
/// (quantity=null → scalable must be false). See PRD §4.5 edge cases.
/// </summary>
public class IngredientTests
{
    private static Ingredient NewIngredient(
        int position = 0,
        decimal? quantity = 250m,
        string unit = "g",
        string name = "Mehl",
        string? note = null,
        bool scalable = true)
    {
        return new Ingredient(
            recipeId: Guid.NewGuid(),
            position: position,
            quantity: quantity,
            unit: unit,
            name: name,
            note: note,
            scalable: scalable);
    }

    [Fact]
    public void Constructor_Sets_Basic_Fields()
    {
        var recipeId = Guid.NewGuid();
        var ingredient = new Ingredient(
            recipeId: recipeId,
            position: 0,
            quantity: 250m,
            unit: "g",
            name: "Mehl",
            note: "gesiebt",
            scalable: true);

        Assert.NotEqual(Guid.Empty, ingredient.Id);
        Assert.Equal(recipeId, ingredient.RecipeId);
        Assert.Equal(0, ingredient.Position);
        Assert.Equal(250m, ingredient.Quantity);
        Assert.Equal("g", ingredient.Unit);
        Assert.Equal("Mehl", ingredient.Name);
        Assert.Equal("gesiebt", ingredient.Note);
        Assert.True(ingredient.Scalable);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData(null)]
    public void Constructor_Rejects_Blank_Name(string? invalid)
    {
        Assert.Throws<ArgumentException>(() => NewIngredient(name: invalid!));
    }

    [Fact]
    public void Constructor_Rejects_Name_Longer_Than_200_Chars()
    {
        var tooLong = new string('x', 201);

        Assert.Throws<ArgumentException>(() => NewIngredient(name: tooLong));
    }

    [Fact]
    public void Constructor_Trims_Name()
    {
        var ingredient = NewIngredient(name: "  Mehl  ");

        Assert.Equal("Mehl", ingredient.Name);
    }

    [Fact]
    public void Constructor_Rejects_Negative_Position()
    {
        Assert.Throws<ArgumentException>(() => NewIngredient(position: -1));
    }

    [Fact]
    public void Constructor_Rejects_Unit_Longer_Than_40_Chars()
    {
        var tooLong = new string('u', 41);

        Assert.Throws<ArgumentException>(() => NewIngredient(unit: tooLong));
    }

    [Fact]
    public void Constructor_Allows_Empty_Unit()
    {
        // "1 Ei" — unit can be blank
        var ingredient = NewIngredient(unit: string.Empty, quantity: 1m, name: "Ei");

        Assert.Equal(string.Empty, ingredient.Unit);
    }

    [Fact]
    public void Constructor_Rejects_Note_Longer_Than_200_Chars()
    {
        var tooLong = new string('n', 201);

        Assert.Throws<ArgumentException>(() => NewIngredient(note: tooLong));
    }

    [Fact]
    public void Constructor_Normalizes_Blank_Note_To_Null()
    {
        var ingredient = NewIngredient(note: "   ");

        Assert.Null(ingredient.Note);
    }

    // ── scalability invariants ──────────────────────────────────────

    [Fact]
    public void QuantityNull_Requires_ScalableFalse()
    {
        // "nach Geschmack" — quantity null, scalable must be false.
        Assert.Throws<ArgumentException>(() =>
            NewIngredient(quantity: null, scalable: true));
    }

    [Fact]
    public void QuantityNull_With_ScalableFalse_Succeeds()
    {
        var ingredient = NewIngredient(quantity: null, scalable: false, unit: "Prise", name: "Salz");

        Assert.Null(ingredient.Quantity);
        Assert.False(ingredient.Scalable);
    }

    [Fact]
    public void ScalableTrue_Requires_Quantity_Greater_Than_Zero()
    {
        Assert.Throws<ArgumentException>(() =>
            NewIngredient(quantity: 0m, scalable: true));
    }

    [Fact]
    public void ScalableTrue_Rejects_Negative_Quantity()
    {
        Assert.Throws<ArgumentException>(() =>
            NewIngredient(quantity: -1m, scalable: true));
    }

    [Fact]
    public void ScalableFalse_Allows_Quantity_With_Value()
    {
        // "1 Prise" — quantity given but caller decided it's not scalable.
        var ingredient = NewIngredient(quantity: 1m, scalable: false, unit: "Prise", name: "Salz");

        Assert.Equal(1m, ingredient.Quantity);
        Assert.False(ingredient.Scalable);
    }
}
