namespace SharedCookbook.Domain.Enums;

/// <summary>
/// What kind of change a <see cref="Entities.RecipeRevision"/> records.
/// PRD §4.1 / §8.3 keeps the last 5 entries per recipe; the change-type
/// drives the human-readable label in the history panel and is stored as
/// its underlying integer in EF, so the assignments below are part of
/// the on-disk wire contract.
/// </summary>
public enum RecipeChangeType
{
    /// <summary>The recipe was just created — first revision after the
    /// row appears, or the first revision on a fork's new copy.</summary>
    Created = 0,

    /// <summary>The recipe was edited (PUT). DiffSummary is populated
    /// with a German one-liner describing the field counts that
    /// changed.</summary>
    Edited = 1,

    /// <summary>The recipe was created as a fork of another. Phase 1
    /// emits this on the source recipe to mark the fork point; the new
    /// copy gets its own <see cref="Created"/> entry per S5/S6 spec.</summary>
    Forked = 2,
}
