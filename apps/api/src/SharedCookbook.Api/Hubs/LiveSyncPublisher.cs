using SharedCookbook.Domain.Entities;
using SharedCookbook.Domain.Enums;
using Microsoft.AspNetCore.SignalR;

namespace SharedCookbook.Api.Hubs;

/// <summary>
/// Thin façade over <see cref="IHubContext{THub}"/> so endpoint
/// handlers don't have to know the hub's method-name strings or build
/// payload records inline. Keeps the coupling between endpoints and
/// the SignalR transport one service-injection wide.
///
/// The publisher is stateless and scoped — registered as a singleton
/// wrapping the singleton <see cref="IHubContext{LiveSyncHub}"/>.
/// </summary>
public interface ILiveSyncPublisher
{
    Task MealPlanSlotChangedAsync(
        Guid groupId,
        Guid planId,
        Guid slotId,
        string weekStart,
        LiveSyncAction action,
        CancellationToken ct = default);

    Task MealPlanChangedAsync(
        Guid groupId,
        Guid planId,
        string weekStart,
        LiveSyncAction action,
        CancellationToken ct = default);

    Task ShoppingListItemChangedAsync(
        Guid groupId,
        Guid planId,
        Guid listId,
        Guid itemId,
        LiveSyncAction action,
        CancellationToken ct = default);

    /// <summary>
    /// PV1 — publishes a <c>RecipeImportProgressChanged</c> event to the
    /// owning group so every logged-in family member watching the import
    /// page gets the phase/percentage update within ~100ms. Fan-out is
    /// scoped to <c>group:{import.GroupId}</c> — never to "all clients"
    /// — so cross-group snooping stays impossible.
    /// </summary>
    Task RecipeImportProgressChangedAsync(
        RecipeImport import,
        CancellationToken ct = default);
}

public sealed class LiveSyncPublisher : ILiveSyncPublisher
{
    private readonly IHubContext<LiveSyncHub> _hub;

    public LiveSyncPublisher(IHubContext<LiveSyncHub> hub)
    {
        _hub = hub;
    }

    public Task MealPlanSlotChangedAsync(
        Guid groupId,
        Guid planId,
        Guid slotId,
        string weekStart,
        LiveSyncAction action,
        CancellationToken ct = default)
    {
        var payload = new MealPlanSlotChangedPayload(
            PlanId: planId,
            SlotId: slotId,
            GroupId: groupId,
            WeekStart: weekStart,
            Action: action.ToWire());
        return _hub.Clients.Group(LiveSyncHub.GroupName(groupId))
            .SendAsync(LiveSyncEvents.MealPlanSlotChanged, payload, ct);
    }

    public Task MealPlanChangedAsync(
        Guid groupId,
        Guid planId,
        string weekStart,
        LiveSyncAction action,
        CancellationToken ct = default)
    {
        var payload = new MealPlanChangedPayload(
            PlanId: planId,
            GroupId: groupId,
            WeekStart: weekStart,
            Action: action.ToWire());
        return _hub.Clients.Group(LiveSyncHub.GroupName(groupId))
            .SendAsync(LiveSyncEvents.MealPlanChanged, payload, ct);
    }

    public Task ShoppingListItemChangedAsync(
        Guid groupId,
        Guid planId,
        Guid listId,
        Guid itemId,
        LiveSyncAction action,
        CancellationToken ct = default)
    {
        var payload = new ShoppingListItemChangedPayload(
            ListId: listId,
            ItemId: itemId,
            PlanId: planId,
            Action: action.ToWire());
        return _hub.Clients.Group(LiveSyncHub.GroupName(groupId))
            .SendAsync(LiveSyncEvents.ShoppingListItemChanged, payload, ct);
    }

    public Task RecipeImportProgressChangedAsync(
        RecipeImport import,
        CancellationToken ct = default)
    {
        if (import is null) throw new ArgumentNullException(nameof(import));

        var payload = new RecipeImportProgressPayload(
            ImportId: import.Id,
            GroupId: import.GroupId,
            Phase: RecipeImportPhaseWire.ToWire(import.Phase),
            Progress: import.Progress,
            PhaseProgress: import.PhaseProgress,
            ProgressLabel: import.ProgressLabel ?? string.Empty,
            AttemptNumber: import.AttemptNumber,
            BytesDownloaded: import.BytesDownloaded,
            BytesTotal: import.BytesTotal,
            SegmentsDone: import.SegmentsDone,
            SegmentsTotal: import.SegmentsTotal);
        return _hub.Clients.Group(LiveSyncHub.GroupName(import.GroupId))
            .SendAsync(LiveSyncEvents.RecipeImportProgressChanged, payload, ct);
    }
}

/// <summary>
/// Wire-format conversion for <see cref="RecipeImportPhase"/> — lower
/// snake_case matches the Python extractor's callback body
/// (<c>"post_processing"</c>) and the frontend's
/// <c>RecipeImportPhase</c> union. Centralising it here keeps the
/// on-wire mapping in one place for both publisher and endpoint parser.
/// </summary>
public static class RecipeImportPhaseWire
{
    public static string ToWire(RecipeImportPhase phase) => phase switch
    {
        RecipeImportPhase.Queued => "queued",
        RecipeImportPhase.Downloading => "downloading",
        RecipeImportPhase.Transcribing => "transcribing",
        RecipeImportPhase.Structuring => "structuring",
        RecipeImportPhase.PostProcessing => "post_processing",
        RecipeImportPhase.VisionAnalysis => "vision_analysis",
        RecipeImportPhase.Done => "done",
        RecipeImportPhase.Error => "error",
        _ => throw new ArgumentOutOfRangeException(nameof(phase), phase, null),
    };

    public static bool TryParse(string? raw, out RecipeImportPhase phase)
    {
        phase = default;
        if (string.IsNullOrWhiteSpace(raw)) return false;
        switch (raw.Trim().ToLowerInvariant())
        {
            case "queued": phase = RecipeImportPhase.Queued; return true;
            case "downloading": phase = RecipeImportPhase.Downloading; return true;
            case "transcribing": phase = RecipeImportPhase.Transcribing; return true;
            case "structuring": phase = RecipeImportPhase.Structuring; return true;
            case "post_processing": phase = RecipeImportPhase.PostProcessing; return true;
            case "vision_analysis": phase = RecipeImportPhase.VisionAnalysis; return true;
            case "done": phase = RecipeImportPhase.Done; return true;
            case "error": phase = RecipeImportPhase.Error; return true;
            default: return false;
        }
    }
}
