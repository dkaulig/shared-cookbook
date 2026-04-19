using FamilienKochbuch.Domain.MealPlanning;
using Xunit;

namespace FamilienKochbuch.Domain.Tests.MealPlanning;

/// <summary>
/// Invariants for <see cref="MealPlanSlot"/> per plan §Data model + §P3-0:
/// Servings 1..20, Date within week, Label-or-Recipe, Label max 120 chars,
/// no parent-cycles, parent must be in the same plan.
/// </summary>
public class MealPlanSlotTests
{
    // Monday 2026-04-20 + the six following days — hardcoded so the tests
    // never drift with the clock.
    private static readonly DateOnly Monday = new(2026, 4, 20);
    private static readonly DateOnly Sunday = new(2026, 4, 26);
    private static readonly DateOnly PreviousSunday = new(2026, 4, 19);
    private static readonly DateOnly NextMonday = new(2026, 4, 27);

    private static MealPlanSlot NewSlot(
        Guid mealPlanId,
        DateOnly? date = null,
        int servings = 2,
        Guid? recipeId = null,
        string? label = null,
        int sortOrder = 0)
    {
        return new MealPlanSlot(
            mealPlanId: mealPlanId,
            weekStart: Monday,
            date: date ?? Monday,
            meal: MealSlot.Mittag,
            servings: servings,
            recipeId: recipeId ?? Guid.NewGuid(),
            label: label,
            sortOrder: sortOrder,
            createdAt: DateTimeOffset.UtcNow);
    }

    [Fact]
    public void Constructor_Creates_Valid_Slot_With_Recipe()
    {
        var mealPlanId = Guid.NewGuid();
        var recipeId = Guid.NewGuid();

        var slot = new MealPlanSlot(
            mealPlanId: mealPlanId,
            weekStart: Monday,
            date: Monday,
            meal: MealSlot.Mittag,
            servings: 4,
            recipeId: recipeId,
            label: null,
            sortOrder: 0,
            createdAt: DateTimeOffset.UtcNow);

        Assert.NotEqual(Guid.Empty, slot.Id);
        Assert.Equal(mealPlanId, slot.MealPlanId);
        Assert.Equal(Monday, slot.Date);
        Assert.Equal(MealSlot.Mittag, slot.Meal);
        Assert.Equal(4, slot.Servings);
        Assert.Equal(recipeId, slot.RecipeId);
        Assert.Null(slot.Label);
        Assert.Equal(0, slot.SortOrder);
        Assert.False(slot.IsCooked);
        Assert.Null(slot.ParentSlotId);
    }

    [Fact]
    public void Constructor_Creates_Valid_Freeform_Slot_With_Label_Only()
    {
        var slot = new MealPlanSlot(
            mealPlanId: Guid.NewGuid(),
            weekStart: Monday,
            date: Monday,
            meal: MealSlot.Abend,
            servings: 2,
            recipeId: null,
            label: "Restaurant",
            sortOrder: 0,
            createdAt: DateTimeOffset.UtcNow);

        Assert.Null(slot.RecipeId);
        Assert.Equal("Restaurant", slot.Label);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(21)]
    [InlineData(100)]
    public void Constructor_Rejects_Servings_Outside_1_To_20(int invalid)
    {
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            NewSlot(Guid.NewGuid(), servings: invalid));
    }

    [Theory]
    [InlineData(1)]
    [InlineData(10)]
    [InlineData(20)]
    public void Constructor_Accepts_Servings_At_Boundaries(int valid)
    {
        var slot = NewSlot(Guid.NewGuid(), servings: valid);

        Assert.Equal(valid, slot.Servings);
    }

    [Fact]
    public void Constructor_Rejects_Date_Before_WeekStart()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            NewSlot(Guid.NewGuid(), date: PreviousSunday));
    }

    [Fact]
    public void Constructor_Rejects_Date_After_WeekStart_Plus_Six_Days()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            NewSlot(Guid.NewGuid(), date: NextMonday));
    }

    [Fact]
    public void Constructor_Accepts_Date_On_Sunday_Boundary()
    {
        var slot = NewSlot(Guid.NewGuid(), date: Sunday);

        Assert.Equal(Sunday, slot.Date);
    }

    [Fact]
    public void Constructor_Rejects_Both_RecipeId_And_Label_Null()
    {
        Assert.Throws<ArgumentException>(() => new MealPlanSlot(
            mealPlanId: Guid.NewGuid(),
            weekStart: Monday,
            date: Monday,
            meal: MealSlot.Mittag,
            servings: 2,
            recipeId: null,
            label: null,
            sortOrder: 0,
            createdAt: DateTimeOffset.UtcNow));
    }

    [Fact]
    public void Constructor_Rejects_Label_Longer_Than_120_Chars()
    {
        var tooLong = new string('x', 121);

        Assert.Throws<ArgumentException>(() => new MealPlanSlot(
            mealPlanId: Guid.NewGuid(),
            weekStart: Monday,
            date: Monday,
            meal: MealSlot.Mittag,
            servings: 2,
            recipeId: null,
            label: tooLong,
            sortOrder: 0,
            createdAt: DateTimeOffset.UtcNow));
    }

    [Fact]
    public void Constructor_Accepts_Label_At_120_Chars_Boundary()
    {
        var boundary = new string('x', 120);

        var slot = new MealPlanSlot(
            mealPlanId: Guid.NewGuid(),
            weekStart: Monday,
            date: Monday,
            meal: MealSlot.Mittag,
            servings: 2,
            recipeId: null,
            label: boundary,
            sortOrder: 0,
            createdAt: DateTimeOffset.UtcNow);

        Assert.Equal(boundary, slot.Label);
    }

    [Fact]
    public void Constructor_Trims_Label()
    {
        var slot = new MealPlanSlot(
            mealPlanId: Guid.NewGuid(),
            weekStart: Monday,
            date: Monday,
            meal: MealSlot.Mittag,
            servings: 2,
            recipeId: null,
            label: "  Restaurant  ",
            sortOrder: 0,
            createdAt: DateTimeOffset.UtcNow);

        Assert.Equal("Restaurant", slot.Label);
    }

    [Fact]
    public void SetParent_Rejects_Self_Reference()
    {
        var slot = NewSlot(Guid.NewGuid());

        Assert.False(slot.CanSetParent(slot));
        Assert.Throws<InvalidOperationException>(() =>
            slot.SetParent(slot, DateTimeOffset.UtcNow));
    }

    [Fact]
    public void SetParent_Rejects_Parent_From_Different_MealPlan()
    {
        var planA = Guid.NewGuid();
        var planB = Guid.NewGuid();
        var childInA = NewSlot(planA);
        var parentInB = NewSlot(planB);

        Assert.False(childInA.CanSetParent(parentInB));
        Assert.Throws<InvalidOperationException>(() =>
            childInA.SetParent(parentInB, DateTimeOffset.UtcNow));
    }

    [Fact]
    public void SetParent_Rejects_Cycle_A_To_B_Then_B_To_A()
    {
        var plan = Guid.NewGuid();
        var a = NewSlot(plan);
        var b = NewSlot(plan);

        // First link: A→B (B is A's parent). Legal.
        a.SetParent(b, DateTimeOffset.UtcNow);

        // Now try B→A (A would become B's parent) — that closes the cycle.
        Assert.False(b.CanSetParent(a));
        Assert.Throws<InvalidOperationException>(() =>
            b.SetParent(a, DateTimeOffset.UtcNow));
    }

    [Fact]
    public void SetParent_Accepts_Parent_Within_Same_Plan()
    {
        var plan = Guid.NewGuid();
        var child = NewSlot(plan);
        var parent = NewSlot(plan);

        child.SetParent(parent, DateTimeOffset.UtcNow);

        Assert.Equal(parent.Id, child.ParentSlotId);
        Assert.Same(parent, child.ParentSlot);
    }

    [Fact]
    public void SetParent_Null_Detaches_Existing_Parent()
    {
        var plan = Guid.NewGuid();
        var child = NewSlot(plan);
        var parent = NewSlot(plan);
        child.SetParent(parent, DateTimeOffset.UtcNow);

        child.SetParent(null, DateTimeOffset.UtcNow);

        Assert.Null(child.ParentSlotId);
        Assert.Null(child.ParentSlot);
    }

    [Fact]
    public void SetCooked_Toggles_Flag_And_Updates_Timestamp()
    {
        var slot = NewSlot(Guid.NewGuid());
        var later = DateTimeOffset.UtcNow.AddHours(1);

        slot.SetCooked(true, later);

        Assert.True(slot.IsCooked);
        Assert.Equal(later, slot.UpdatedAt);
    }

    [Fact]
    public void UpdateServings_Validates_Range()
    {
        var slot = NewSlot(Guid.NewGuid());

        Assert.Throws<ArgumentOutOfRangeException>(() =>
            slot.UpdateServings(0, DateTimeOffset.UtcNow));
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            slot.UpdateServings(21, DateTimeOffset.UtcNow));

        slot.UpdateServings(5, DateTimeOffset.UtcNow);
        Assert.Equal(5, slot.Servings);
    }

    [Fact]
    public void Constructor_Accepts_Slot_With_Both_RecipeId_And_Label()
    {
        // Recipe + optional label is a legal combination — e.g. "Spätzle"
        // with personal-note label "Meal Prep".
        var slot = new MealPlanSlot(
            mealPlanId: Guid.NewGuid(),
            weekStart: Monday,
            date: Monday,
            meal: MealSlot.Mittag,
            servings: 4,
            recipeId: Guid.NewGuid(),
            label: "Meal Prep",
            sortOrder: 0,
            createdAt: DateTimeOffset.UtcNow);

        Assert.NotNull(slot.RecipeId);
        Assert.Equal("Meal Prep", slot.Label);
    }

    [Fact]
    public void Constructor_Rejects_Empty_MealPlanId()
    {
        Assert.Throws<ArgumentException>(() => new MealPlanSlot(
            mealPlanId: Guid.Empty,
            weekStart: Monday,
            date: Monday,
            meal: MealSlot.Mittag,
            servings: 2,
            recipeId: Guid.NewGuid(),
            label: null,
            sortOrder: 0,
            createdAt: DateTimeOffset.UtcNow));
    }
}
