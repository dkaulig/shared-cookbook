namespace SharedCookbook.Domain.MealPlanning;

/// <summary>
/// Time-of-day bucket for a <see cref="MealPlanSlot"/>. Four discrete values
/// keep the week-grid rendering deterministic without committing to user
/// localisation at the storage layer — the UI translates the enum to
/// "Frühstück / Mittag / Abend / Snack" labels.
/// Explicit integer values are frozen so future renames keep the on-disk
/// contract (PRD §8 migration safety).
/// </summary>
public enum MealSlot
{
    Frühstück = 0,
    Mittag = 1,
    Abend = 2,
    Snack = 3,
}
