using Microsoft.AspNetCore.SignalR;

namespace FamilienKochbuch.Api.Hubs;

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
}
