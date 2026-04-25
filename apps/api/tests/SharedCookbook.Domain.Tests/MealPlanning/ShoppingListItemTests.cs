using SharedCookbook.Domain.Enums;
using SharedCookbook.Domain.MealPlanning;
using Xunit;

namespace SharedCookbook.Domain.Tests.MealPlanning;

/// <summary>
/// Invariants for the <see cref="ShoppingListItem"/> entity (P3-5).
/// Covers ctor defaults, length caps, optional-string trim + null
/// handling, and the mutator methods the endpoints use.
/// </summary>
public class ShoppingListItemTests
{
    private static ShoppingListItem Build(
        string name = "Tomaten",
        string? quantity = "200",
        string? unit = "g",
        string? note = null,
        IngredientCategory category = IngredientCategory.Sonstiges,
        ShoppingListItemSource source = ShoppingListItemSource.FromPlan,
        int sortOrder = 0,
        bool carriedOver = false)
        => new(
            shoppingListId: Guid.NewGuid(),
            name: name,
            quantity: quantity,
            unit: unit,
            note: note,
            category: category,
            source: source,
            sortOrder: sortOrder,
            carriedOverFromPreviousWeek: carriedOver,
            createdAt: DateTimeOffset.UtcNow);

    [Fact]
    public void Constructor_Sets_Defaults_For_Valid_Input()
    {
        var now = DateTimeOffset.UtcNow;
        var listId = Guid.NewGuid();

        var item = new ShoppingListItem(
            shoppingListId: listId,
            name: "Tomaten",
            quantity: "200",
            unit: "g",
            note: null,
            category: IngredientCategory.Sonstiges,
            source: ShoppingListItemSource.FromPlan,
            sortOrder: 10,
            carriedOverFromPreviousWeek: false,
            createdAt: now);

        Assert.NotEqual(Guid.Empty, item.Id);
        Assert.Equal(listId, item.ShoppingListId);
        Assert.Equal("Tomaten", item.Name);
        Assert.Equal("200", item.Quantity);
        Assert.Equal("g", item.Unit);
        Assert.Null(item.Note);
        Assert.Equal(IngredientCategory.Sonstiges, item.Category);
        Assert.Equal(ShoppingListItemSource.FromPlan, item.Source);
        Assert.Equal(10, item.SortOrder);
        Assert.False(item.IsChecked);
        Assert.False(item.CarriedOverFromPreviousWeek);
        Assert.Equal(now, item.CreatedAt);
        Assert.Equal(now, item.UpdatedAt);
    }

    [Fact]
    public void Constructor_Rejects_Empty_ShoppingListId()
    {
        Assert.Throws<ArgumentException>(() =>
            new ShoppingListItem(
                Guid.Empty, "X", null, null, null,
                IngredientCategory.Sonstiges, ShoppingListItemSource.Manual,
                0, false, DateTimeOffset.UtcNow));
    }

    [Fact]
    public void Constructor_Rejects_Blank_Name()
    {
        Assert.Throws<ArgumentException>(() => Build(name: ""));
        Assert.Throws<ArgumentException>(() => Build(name: "   "));
    }

    [Fact]
    public void Constructor_Trims_Name()
    {
        var item = Build(name: "  Tomaten  ");
        Assert.Equal("Tomaten", item.Name);
    }

    [Fact]
    public void Constructor_Rejects_Name_Above_200_Chars()
    {
        var longName = new string('a', ShoppingListItem.NameMaxLength + 1);
        Assert.Throws<ArgumentException>(() => Build(name: longName));
    }

    [Fact]
    public void Constructor_Accepts_Name_At_Exactly_200_Chars()
    {
        var name = new string('a', ShoppingListItem.NameMaxLength);
        var item = Build(name: name);
        Assert.Equal(name, item.Name);
    }

    [Fact]
    public void Constructor_Rejects_Quantity_Above_50_Chars()
    {
        var longQty = new string('1', ShoppingListItem.QuantityMaxLength + 1);
        Assert.Throws<ArgumentException>(() => Build(quantity: longQty));
    }

    [Fact]
    public void Constructor_Rejects_Unit_Above_50_Chars()
    {
        var longUnit = new string('u', ShoppingListItem.UnitMaxLength + 1);
        Assert.Throws<ArgumentException>(() => Build(unit: longUnit));
    }

    [Fact]
    public void Constructor_Rejects_Note_Above_500_Chars()
    {
        var longNote = new string('n', ShoppingListItem.NoteMaxLength + 1);
        Assert.Throws<ArgumentException>(() => Build(note: longNote));
    }

    [Fact]
    public void Constructor_Normalizes_Blank_Optional_Strings_To_Null()
    {
        var item = Build(quantity: "   ", unit: "", note: " \t ");
        Assert.Null(item.Quantity);
        Assert.Null(item.Unit);
        Assert.Null(item.Note);
    }

    [Fact]
    public void Constructor_Preserves_CarriedOver_Flag()
    {
        var item = Build(carriedOver: true, source: ShoppingListItemSource.CarriedOver);
        Assert.True(item.CarriedOverFromPreviousWeek);
        Assert.Equal(ShoppingListItemSource.CarriedOver, item.Source);
    }

    [Fact]
    public void SetChecked_Toggles_Flag_And_Updates_Timestamp()
    {
        var item = Build();
        var later = DateTimeOffset.UtcNow.AddMinutes(5);

        item.SetChecked(true, later);

        Assert.True(item.IsChecked);
        Assert.Equal(later, item.UpdatedAt);
    }

    [Fact]
    public void SetQuantity_Allows_Null_And_Trims()
    {
        var item = Build(quantity: "200");
        var later = DateTimeOffset.UtcNow.AddMinutes(1);

        item.SetQuantity("  350 g  ", later);
        Assert.Equal("350 g", item.Quantity);
        Assert.Equal(later, item.UpdatedAt);

        item.SetQuantity(null, later);
        Assert.Null(item.Quantity);
    }

    [Fact]
    public void SetQuantity_Rejects_Over_Limit()
    {
        var item = Build();
        var longQty = new string('1', ShoppingListItem.QuantityMaxLength + 1);
        Assert.Throws<ArgumentException>(() =>
            item.SetQuantity(longQty, DateTimeOffset.UtcNow));
    }

    [Fact]
    public void SetUnit_Allows_Null_And_Trims()
    {
        var item = Build(unit: "g");
        item.SetUnit("  kg  ", DateTimeOffset.UtcNow);
        Assert.Equal("kg", item.Unit);
    }

    [Fact]
    public void SetNote_Allows_Null_And_Trims()
    {
        var item = Build();
        item.SetNote("  bio wenn möglich  ", DateTimeOffset.UtcNow);
        Assert.Equal("bio wenn möglich", item.Note);
    }

    [Fact]
    public void Reorder_Updates_SortOrder()
    {
        var item = Build(sortOrder: 0);
        item.Reorder(42, DateTimeOffset.UtcNow);
        Assert.Equal(42, item.SortOrder);
    }

    [Fact]
    public void SetCategory_Updates_Bucket()
    {
        var item = Build();
        item.SetCategory(IngredientCategory.Sonstiges, DateTimeOffset.UtcNow);
        Assert.Equal(IngredientCategory.Sonstiges, item.Category);
    }
}
