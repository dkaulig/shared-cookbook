using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.Enums;

namespace FamilienKochbuch.Infrastructure.Services;

/// <summary>
/// S6 history-tracker for recipe edits. The service snapshots the current
/// recipe state, computes a German diff summary against the previous
/// revision (when applicable), persists the row, and prunes the recipe's
/// history to the most recent five entries. PRD §4.1 / §8.3.
/// </summary>
public interface IRecipeRevisionService
{
    /// <summary>
    /// Records a revision for the recipe identified by <paramref name="recipeId"/>.
    /// The recipe MUST already be persisted (with its child collections
    /// loaded as needed); the call snapshots the current state and persists
    /// the row in a single SaveChangesAsync. For <see cref="RecipeChangeType.Edited"/>
    /// the call is a no-op when the snapshot is identical to the previous
    /// revision — this is what guards against noise from no-op PUTs.
    /// </summary>
    /// <param name="sourceDescription">
    /// Optional human-readable note for <see cref="RecipeChangeType.Forked"/>
    /// revisions (e.g. "Geforkt aus Gruppe Familie"). Trimmed and length-
    /// validated by the entity. Ignored for other change types.
    /// </param>
    Task RecordAsync(
        Guid recipeId,
        Guid changedByUserId,
        RecipeChangeType changeType,
        DateTimeOffset now,
        CancellationToken ct,
        string? sourceDescription = null);

    /// <summary>
    /// Returns the latest <paramref name="take"/> revisions for the recipe,
    /// newest first. Default of 5 matches the PRD's history cap.
    /// </summary>
    Task<IReadOnlyList<RecipeRevision>> GetLastAsync(
        Guid recipeId,
        int take = 5,
        CancellationToken ct = default);
}
