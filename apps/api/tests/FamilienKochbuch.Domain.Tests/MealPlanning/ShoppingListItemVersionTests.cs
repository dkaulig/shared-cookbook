using FamilienKochbuch.Domain.Common;
using FamilienKochbuch.Domain.Enums;
using FamilienKochbuch.Domain.MealPlanning;
using Xunit;

namespace FamilienKochbuch.Domain.Tests.MealPlanning;

/// <summary>
/// OFF3: asserts <see cref="ShoppingListItem"/> implements
/// <see cref="IVersionedEntity"/> and every public mutation method
/// bumps <see cref="ShoppingListItem.Version"/> exactly once.
/// </summary>
public class ShoppingListItemVersionTests
{
    private static ShoppingListItem NewItem() => new(
        shoppingListId: Guid.NewGuid(),
        name: "Zwiebeln",
        quantity: "2",
        unit: "Stück",
        note: null,
        category: IngredientCategory.ObstGemuese,
        source: ShoppingListItemSource.Manual,
        sortOrder: 0,
        carriedOverFromPreviousWeek: false,
        createdAt: DateTimeOffset.UtcNow);

    [Fact]
    public void Implements_IVersionedEntity()
    {
        Assert.IsAssignableFrom<IVersionedEntity>(NewItem());
    }

    [Fact]
    public void Constructor_Initialises_Version_To_Zero()
    {
        Assert.Equal(0, NewItem().Version);
    }

    [Fact]
    public void SetChecked_Bumps_Version_Once()
    {
        var i = NewItem();
        var before = i.Version;

        i.SetChecked(true, DateTimeOffset.UtcNow);

        Assert.Equal(before + 1, i.Version);
    }

    [Fact]
    public void SetQuantity_Bumps_Version_Once()
    {
        var i = NewItem();
        var before = i.Version;

        i.SetQuantity("3", DateTimeOffset.UtcNow);

        Assert.Equal(before + 1, i.Version);
    }

    [Fact]
    public void SetUnit_Bumps_Version_Once()
    {
        var i = NewItem();
        var before = i.Version;

        i.SetUnit("kg", DateTimeOffset.UtcNow);

        Assert.Equal(before + 1, i.Version);
    }

    [Fact]
    public void SetNote_Bumps_Version_Once()
    {
        var i = NewItem();
        var before = i.Version;

        i.SetNote("frisch", DateTimeOffset.UtcNow);

        Assert.Equal(before + 1, i.Version);
    }

    [Fact]
    public void Reorder_Bumps_Version_Once()
    {
        var i = NewItem();
        var before = i.Version;

        i.Reorder(5, DateTimeOffset.UtcNow);

        Assert.Equal(before + 1, i.Version);
    }

    [Fact]
    public void SetCategory_Bumps_Version_Once()
    {
        var i = NewItem();
        var before = i.Version;

        i.SetCategory(IngredientCategory.Trockenwaren, DateTimeOffset.UtcNow);

        Assert.Equal(before + 1, i.Version);
    }

    [Fact]
    public void Multiple_Mutations_Accumulate()
    {
        var i = NewItem();

        i.SetChecked(true, DateTimeOffset.UtcNow);
        i.SetNote("x", DateTimeOffset.UtcNow);
        i.Reorder(1, DateTimeOffset.UtcNow);

        Assert.Equal(3, i.Version);
    }
}
