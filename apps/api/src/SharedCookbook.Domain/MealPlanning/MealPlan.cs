using SharedCookbook.Domain.Common;

namespace SharedCookbook.Domain.MealPlanning;

/// <summary>
/// A weekly meal plan for a single <see cref="Entities.Group"/>. One row per
/// (<see cref="GroupId"/>, <see cref="WeekStart"/>) pair — enforced by a
/// unique index at the DB level so two concurrent clients cannot race a plan
/// into existence for the same week (plan §Data model / §P3-0).
///
/// <see cref="Version"/> is incremented whenever the aggregate's slot
/// collection mutates; P3-9 uses it for optimistic concurrency + a
/// light-weight edit history. OFF3 (Phase 5) additionally uses it as the
/// ETag payload for the mutation endpoints.
/// </summary>
public sealed class MealPlan : IVersionedEntity
{
    // EF-friendly parameterless ctor — private so all domain construction
    // goes through the validating ctor below.
    private MealPlan() { }

    public MealPlan(
        Guid groupId,
        DateOnly weekStart,
        DateTimeOffset createdAt)
    {
        if (groupId == Guid.Empty)
            throw new ArgumentException("GroupId must not be empty.", nameof(groupId));

        Id = Guid.NewGuid();
        GroupId = groupId;
        WeekStart = weekStart;
        Version = 0;
        CreatedAt = createdAt;
        UpdatedAt = createdAt;
    }

    public Guid Id { get; private set; }
    public Guid GroupId { get; private set; }
    public DateOnly WeekStart { get; private set; }
    public int Version { get; private set; }
    public DateTimeOffset CreatedAt { get; private set; }
    public DateTimeOffset UpdatedAt { get; private set; }

    /// <summary>
    /// Child slots. EF owns the back-reference on <see cref="MealPlanSlot"/>
    /// so this collection is a read model for the API layer — mutations go
    /// through the repository + endpoint code in P3-1.
    /// </summary>
    public ICollection<MealPlanSlot> Slots { get; private set; } = new List<MealPlanSlot>();

    /// <summary>
    /// Bumps <see cref="Version"/> and refreshes <see cref="UpdatedAt"/>.
    /// Call after any slot-level change; P3-9 wraps this in a unit-of-
    /// work so a single "save" mutates the version exactly once regardless
    /// of how many slot-rows changed.
    /// </summary>
    public void BumpVersion(DateTimeOffset at)
    {
        Version++;
        UpdatedAt = at;
    }

    /// <summary>
    /// <see cref="IVersionedEntity.BumpVersion"/> implementation — bumps
    /// the version without touching <see cref="UpdatedAt"/>. Endpoints
    /// that also want to refresh the timestamp should prefer the
    /// <see cref="BumpVersion(DateTimeOffset)"/> overload; this
    /// parameterless form exists so the aggregate satisfies the cross-
    /// cutting OFF3 interface.
    /// </summary>
    void IVersionedEntity.BumpVersion() => Version++;
}
