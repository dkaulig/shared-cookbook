namespace SharedCookbook.Api.Hubs;

/// <summary>
/// Canonical SignalR event names the <see cref="LiveSyncHub"/> emits
/// to clients. The shared-types TypeScript equivalent lives in
/// <c>packages/shared/src/types/liveSync.ts</c> as
/// <c>LiveSyncEventNames</c> — keep both in lockstep when adding
/// events.
/// </summary>
internal static class LiveSyncEvents
{
    public const string MealPlanSlotChanged = "MealPlanSlotChanged";
    public const string MealPlanChanged = "MealPlanChanged";
    public const string ShoppingListItemChanged = "ShoppingListItemChanged";

    /// <summary>
    /// PV1 — published every time the Python extractor's progress
    /// callback is accepted by <c>RecipeImport.UpdateProgress</c>
    /// (out-of-order + stale-retry callbacks do NOT trigger a publish).
    /// The payload carries the full authoritative state so the
    /// frontend applies it via <c>queryClient.setQueryData</c> without a
    /// re-fetch.
    /// </summary>
    public const string RecipeImportProgressChanged = "RecipeImportProgressChanged";
}

/// <summary>Create/update/delete marker on each event payload.</summary>
public enum LiveSyncAction
{
    Created,
    Updated,
    Deleted,
}
