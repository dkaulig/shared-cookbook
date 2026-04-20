using FamilienKochbuch.Domain.Common;
using FamilienKochbuch.Domain.MealPlanning;
using Xunit;

namespace FamilienKochbuch.Domain.Tests.MealPlanning;

/// <summary>
/// OFF3: asserts <see cref="ShoppingList"/> implements
/// <see cref="IVersionedEntity"/> and every public mutation method
/// bumps <see cref="ShoppingList.Version"/> exactly once.
/// </summary>
public class ShoppingListVersionTests
{
    private static ShoppingList NewList() =>
        new(mealPlanId: Guid.NewGuid(), createdAt: DateTimeOffset.UtcNow);

    [Fact]
    public void Implements_IVersionedEntity()
    {
        Assert.IsAssignableFrom<IVersionedEntity>(NewList());
    }

    [Fact]
    public void Constructor_Initialises_Version_To_Zero()
    {
        Assert.Equal(0, NewList().Version);
    }

    [Fact]
    public void MarkRegenerated_Bumps_Version_Once()
    {
        var l = NewList();
        var before = l.Version;

        l.MarkRegenerated(DateTimeOffset.UtcNow.AddMinutes(5));

        Assert.Equal(before + 1, l.Version);
    }

    [Fact]
    public void Touch_Bumps_Version_Once()
    {
        var l = NewList();
        var before = l.Version;

        l.Touch(DateTimeOffset.UtcNow.AddMinutes(1));

        Assert.Equal(before + 1, l.Version);
    }

    [Fact]
    public void Multiple_Mutations_Accumulate()
    {
        var l = NewList();

        l.Touch(DateTimeOffset.UtcNow);
        l.MarkRegenerated(DateTimeOffset.UtcNow);
        l.Touch(DateTimeOffset.UtcNow);

        Assert.Equal(3, l.Version);
    }
}
