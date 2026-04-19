using FamilienKochbuch.Domain.MealPlanning;
using Xunit;

namespace FamilienKochbuch.Domain.Tests.MealPlanning;

/// <summary>
/// Invariants for the <see cref="ShoppingList"/> aggregate root (P3-5).
/// One row per MealPlan, timestamps tracked for optimistic concurrency +
/// carryover-merge decisions.
/// </summary>
public class ShoppingListTests
{
    [Fact]
    public void Constructor_Sets_Defaults_For_Valid_Input()
    {
        var now = DateTimeOffset.UtcNow;
        var planId = Guid.NewGuid();

        var list = new ShoppingList(planId, now);

        Assert.NotEqual(Guid.Empty, list.Id);
        Assert.Equal(planId, list.MealPlanId);
        Assert.Equal(now, list.CreatedAt);
        Assert.Equal(now, list.UpdatedAt);
        Assert.Equal(now, list.LastGeneratedAt);
        Assert.Empty(list.Items);
    }

    [Fact]
    public void Constructor_Rejects_Empty_MealPlanId()
    {
        Assert.Throws<ArgumentException>(() =>
            new ShoppingList(Guid.Empty, DateTimeOffset.UtcNow));
    }

    [Fact]
    public void MarkRegenerated_Updates_Both_Timestamps()
    {
        var list = new ShoppingList(Guid.NewGuid(), DateTimeOffset.UtcNow);
        var later = DateTimeOffset.UtcNow.AddHours(2);

        list.MarkRegenerated(later);

        Assert.Equal(later, list.LastGeneratedAt);
        Assert.Equal(later, list.UpdatedAt);
    }

    [Fact]
    public void Touch_Updates_Only_UpdatedAt_Not_LastGeneratedAt()
    {
        var initial = DateTimeOffset.UtcNow;
        var list = new ShoppingList(Guid.NewGuid(), initial);
        var later = initial.AddMinutes(30);

        list.Touch(later);

        Assert.Equal(later, list.UpdatedAt);
        Assert.Equal(initial, list.LastGeneratedAt);
    }
}
