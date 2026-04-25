namespace SharedCookbook.Domain.Enums;

/// <summary>
/// Provenance of a <see cref="MealPlanning.ShoppingListItem"/> row.
/// Used by the regenerate pipeline (P3-5) to decide which rows to
/// recompute from the MealPlan, which to leave alone (manual entries
/// the user typed in, week-specific), and which to carry-over into a
/// subsequent week.
/// Stored as an int in the DB so future value renames don't silently
/// reclassify existing rows.
/// </summary>
public enum ShoppingListItemSource
{
    /// <summary>Auto-generated from a recipe on a MealPlanSlot.</summary>
    FromPlan = 0,

    /// <summary>User-added via the manual-add endpoint; week-specific and never carried over.</summary>
    Manual = 1,

    /// <summary>Carried over from a previous week's unchecked items (see plan §Carryover).</summary>
    CarriedOver = 2,
}
