using SharedCookbook.Domain.Common;
using SharedCookbook.Domain.MealPlanning;
using Xunit;

namespace SharedCookbook.Domain.Tests.MealPlanning;

/// <summary>
/// Invariants for the <see cref="MealPlan"/> aggregate root. See plan
/// §Data model + §P3-0: one plan per (Group, WeekStart), Version starts at 0
/// and bumps on slot changes, timestamps tracked for optimistic concurrency.
/// </summary>
public class MealPlanTests
{
    // Monday 2026-04-20 per the P3-0 dispatch brief — hardcoded so the
    // test anchor never drifts with the clock.
    private static readonly DateOnly Monday = new(2026, 4, 20);

    [Fact]
    public void Constructor_Sets_Defaults_For_Valid_Input()
    {
        var now = DateTimeOffset.UtcNow;
        var groupId = Guid.NewGuid();

        var plan = new MealPlan(groupId, Monday, now);

        Assert.NotEqual(Guid.Empty, plan.Id);
        Assert.Equal(groupId, plan.GroupId);
        Assert.Equal(Monday, plan.WeekStart);
        Assert.Equal(0, plan.Version);
        Assert.Equal(now, plan.CreatedAt);
        Assert.Equal(now, plan.UpdatedAt);
        Assert.Empty(plan.Slots);
    }

    [Fact]
    public void Constructor_Rejects_Empty_GroupId()
    {
        Assert.Throws<ArgumentException>(() =>
            new MealPlan(Guid.Empty, Monday, DateTimeOffset.UtcNow));
    }

    [Fact]
    public void BumpVersion_Increments_And_Updates_Timestamp()
    {
        var plan = new MealPlan(Guid.NewGuid(), Monday, DateTimeOffset.UtcNow);
        var before = plan.Version;
        var later = DateTimeOffset.UtcNow.AddMinutes(5);

        plan.BumpVersion(later);

        Assert.Equal(before + 1, plan.Version);
        Assert.Equal(later, plan.UpdatedAt);
    }

    [Fact]
    public void BumpVersion_Is_Cumulative()
    {
        var plan = new MealPlan(Guid.NewGuid(), Monday, DateTimeOffset.UtcNow);

        plan.BumpVersion(DateTimeOffset.UtcNow);
        plan.BumpVersion(DateTimeOffset.UtcNow);
        plan.BumpVersion(DateTimeOffset.UtcNow);

        Assert.Equal(3, plan.Version);
    }

    [Fact]
    public void Implements_IVersionedEntity_Interface()
    {
        // OFF3: MealPlan adopts the cross-cutting IVersionedEntity
        // contract alongside its existing timestamped BumpVersion
        // overload. The parameterless form must bump the same counter.
        var plan = new MealPlan(Guid.NewGuid(), Monday, DateTimeOffset.UtcNow);
        IVersionedEntity versioned = plan;

        versioned.BumpVersion();

        Assert.Equal(1, plan.Version);
    }
}
