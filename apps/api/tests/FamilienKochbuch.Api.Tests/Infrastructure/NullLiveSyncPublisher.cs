using FamilienKochbuch.Api.Hubs;
using FamilienKochbuch.Domain.Entities;

namespace FamilienKochbuch.Api.Tests.Infrastructure;

/// <summary>
/// No-op implementation of <see cref="ILiveSyncPublisher"/> for unit /
/// integration tests that do not care about SignalR fan-out but need
/// to construct types that require the dependency. Tests that want to
/// assert publisher behaviour use the purpose-built recorders in the
/// respective test classes (<c>RecordingLiveSyncPublisher</c>,
/// <c>RecordingImportProgressPublisher</c>).
/// </summary>
public sealed class NullLiveSyncPublisher : ILiveSyncPublisher
{
    public Task MealPlanSlotChangedAsync(
        Guid groupId, Guid planId, Guid slotId, string weekStart,
        LiveSyncAction action, CancellationToken ct = default) => Task.CompletedTask;

    public Task MealPlanChangedAsync(
        Guid groupId, Guid planId, string weekStart, LiveSyncAction action,
        CancellationToken ct = default) => Task.CompletedTask;

    public Task ShoppingListItemChangedAsync(
        Guid groupId, Guid planId, Guid listId, Guid itemId,
        LiveSyncAction action, CancellationToken ct = default) => Task.CompletedTask;

    public Task RecipeImportProgressChangedAsync(
        RecipeImport import,
        CancellationToken ct = default) => Task.CompletedTask;
}
