using System.Text.Json.Serialization;

namespace FamilienKochbuch.Api.Hubs;

/// <summary>
/// JSON-serialisation camelCase contract for payloads emitted by
/// <see cref="LiveSyncHub"/>. Event payloads travel over the wire as
/// lowercase-first keys so the frontend types (liveSync.ts) can bind
/// without per-property [JsonPropertyName] decoration.
/// </summary>
internal static class LiveSyncJsonNaming
{
    public static string ToWire(this LiveSyncAction action) => action switch
    {
        LiveSyncAction.Created => "created",
        LiveSyncAction.Updated => "updated",
        LiveSyncAction.Deleted => "deleted",
        _ => throw new ArgumentOutOfRangeException(nameof(action), action, null),
    };
}

/// <summary>
/// Published on <c>MealPlanSlotChanged</c>. Carries the
/// (groupId, weekStart) pair so the frontend can invalidate the
/// TanStack-Query cache keyed as <c>['mealplan', groupId, weekStart]</c>
/// without maintaining a planId lookup.
/// </summary>
public sealed record MealPlanSlotChangedPayload(
    [property: JsonPropertyName("planId")] Guid PlanId,
    [property: JsonPropertyName("slotId")] Guid SlotId,
    [property: JsonPropertyName("groupId")] Guid GroupId,
    [property: JsonPropertyName("weekStart")] string WeekStart,
    [property: JsonPropertyName("action")] string Action);

/// <summary>
/// Published on <c>MealPlanChanged</c> — fires when the plan row itself
/// is created, its version bumps as a side effect of slot changes, or
/// it is deleted.
/// </summary>
public sealed record MealPlanChangedPayload(
    [property: JsonPropertyName("planId")] Guid PlanId,
    [property: JsonPropertyName("groupId")] Guid GroupId,
    [property: JsonPropertyName("weekStart")] string WeekStart,
    [property: JsonPropertyName("action")] string Action);

/// <summary>
/// Published on <c>ShoppingListItemChanged</c>. Keyed by planId so the
/// frontend's <c>['shoppinglist', planId]</c> cache is invalidated
/// directly.
/// </summary>
public sealed record ShoppingListItemChangedPayload(
    [property: JsonPropertyName("listId")] Guid ListId,
    [property: JsonPropertyName("itemId")] Guid ItemId,
    [property: JsonPropertyName("planId")] Guid PlanId,
    [property: JsonPropertyName("action")] string Action);

/// <summary>
/// Published on <c>RecipeImportProgressChanged</c>. Carries the full
/// server-authoritative snapshot for a single <c>RecipeImport</c> row so
/// the frontend can call
/// <c>queryClient.setQueryData(['import', importId], payload)</c>
/// without needing to re-fetch. Shape matches design
/// §SignalR Event.
///
/// <see cref="Phase"/> is the lower-case snake-case wire form of the
/// enum (e.g. <c>"post_processing"</c>) — same convention the Python
/// extractor uses in its callback payload, and the same shape the
/// frontend's <c>RecipeImportPhase</c> union expects.
/// </summary>
public sealed record RecipeImportProgressPayload(
    [property: JsonPropertyName("importId")] Guid ImportId,
    [property: JsonPropertyName("groupId")] Guid GroupId,
    [property: JsonPropertyName("phase")] string Phase,
    [property: JsonPropertyName("progress")] int Progress,
    [property: JsonPropertyName("phaseProgress")] int PhaseProgress,
    [property: JsonPropertyName("progressLabel")] string ProgressLabel,
    [property: JsonPropertyName("attemptNumber")] int AttemptNumber,
    [property: JsonPropertyName("bytesDownloaded")] long? BytesDownloaded,
    [property: JsonPropertyName("bytesTotal")] long? BytesTotal,
    [property: JsonPropertyName("segmentsDone")] int? SegmentsDone,
    [property: JsonPropertyName("segmentsTotal")] int? SegmentsTotal);
