using FamilienKochbuch.Api.Hubs;
using Microsoft.AspNetCore.SignalR;
using Xunit;

namespace FamilienKochbuch.Api.Tests.Hubs;

/// <summary>
/// Unit-level assertions for <see cref="LiveSyncPublisher"/> — keeps
/// the hub-method name / payload-shape contract pinned without
/// spinning up the real SignalR transport. Uses a hand-rolled
/// <see cref="IHubContext{THub}"/> fake so we can inspect every
/// argument the publisher forwards.
/// </summary>
public class LiveSyncPublisherTests
{
    [Fact]
    public async Task MealPlanSlotChangedAsync_Sends_Right_Event_Name_And_Payload()
    {
        var hub = new FakeHubContext();
        var publisher = new LiveSyncPublisher(hub);
        var groupId = Guid.NewGuid();
        var planId = Guid.NewGuid();
        var slotId = Guid.NewGuid();

        await publisher.MealPlanSlotChangedAsync(
            groupId: groupId,
            planId: planId,
            slotId: slotId,
            weekStart: "2026-04-20",
            action: LiveSyncAction.Created);

        var captured = Assert.Single(hub.Invocations);
        Assert.Equal($"group:{groupId}", captured.GroupName);
        Assert.Equal("MealPlanSlotChanged", captured.Method);
        var payload = Assert.IsType<MealPlanSlotChangedPayload>(captured.Argument);
        Assert.Equal(planId, payload.PlanId);
        Assert.Equal(slotId, payload.SlotId);
        Assert.Equal(groupId, payload.GroupId);
        Assert.Equal("2026-04-20", payload.WeekStart);
        Assert.Equal("created", payload.Action);
    }

    [Fact]
    public async Task MealPlanChangedAsync_Sends_Right_Event_Name_And_Payload()
    {
        var hub = new FakeHubContext();
        var publisher = new LiveSyncPublisher(hub);
        var groupId = Guid.NewGuid();
        var planId = Guid.NewGuid();

        await publisher.MealPlanChangedAsync(
            groupId: groupId,
            planId: planId,
            weekStart: "2026-04-27",
            action: LiveSyncAction.Updated);

        var captured = Assert.Single(hub.Invocations);
        Assert.Equal("MealPlanChanged", captured.Method);
        var payload = Assert.IsType<MealPlanChangedPayload>(captured.Argument);
        Assert.Equal(planId, payload.PlanId);
        Assert.Equal("updated", payload.Action);
    }

    [Fact]
    public async Task ShoppingListItemChangedAsync_Sends_Right_Event_Name_And_Payload()
    {
        var hub = new FakeHubContext();
        var publisher = new LiveSyncPublisher(hub);
        var groupId = Guid.NewGuid();
        var planId = Guid.NewGuid();
        var listId = Guid.NewGuid();
        var itemId = Guid.NewGuid();

        await publisher.ShoppingListItemChangedAsync(
            groupId: groupId,
            planId: planId,
            listId: listId,
            itemId: itemId,
            action: LiveSyncAction.Deleted);

        var captured = Assert.Single(hub.Invocations);
        Assert.Equal($"group:{groupId}", captured.GroupName);
        Assert.Equal("ShoppingListItemChanged", captured.Method);
        var payload = Assert.IsType<ShoppingListItemChangedPayload>(captured.Argument);
        Assert.Equal(listId, payload.ListId);
        Assert.Equal(itemId, payload.ItemId);
        Assert.Equal(planId, payload.PlanId);
        Assert.Equal("deleted", payload.Action);
    }

    [Fact]
    public async Task List_Wide_ShoppingList_Events_Use_Empty_ItemId()
    {
        // The Generate endpoint publishes a single list-wide event with
        // itemId=Guid.Empty — verify the publisher lets that through
        // unchanged so the frontend convention stays stable.
        var hub = new FakeHubContext();
        var publisher = new LiveSyncPublisher(hub);

        await publisher.ShoppingListItemChangedAsync(
            groupId: Guid.NewGuid(),
            planId: Guid.NewGuid(),
            listId: Guid.NewGuid(),
            itemId: Guid.Empty,
            action: LiveSyncAction.Created);

        var captured = Assert.Single(hub.Invocations);
        var payload = Assert.IsType<ShoppingListItemChangedPayload>(captured.Argument);
        Assert.Equal(Guid.Empty, payload.ItemId);
    }

    [Fact]
    public void GroupName_Is_Deterministic_For_Same_GroupId()
    {
        var id = Guid.NewGuid();
        Assert.Equal(LiveSyncHub.GroupName(id), LiveSyncHub.GroupName(id));
        Assert.StartsWith("group:", LiveSyncHub.GroupName(id));
    }

    // ── Fakes ────────────────────────────────────────────────────────

    private sealed record CapturedInvocation(string GroupName, string Method, object Argument);

    private sealed class FakeHubContext : IHubContext<LiveSyncHub>
    {
        public List<CapturedInvocation> Invocations { get; } = new();

        public IHubClients Clients => new FakeHubClients(this);
        public IGroupManager Groups => throw new NotImplementedException();
    }

    private sealed class FakeHubClients : IHubClients
    {
        private readonly FakeHubContext _ctx;
        public FakeHubClients(FakeHubContext ctx) { _ctx = ctx; }
        public IClientProxy All => throw new NotImplementedException();
        public IClientProxy AllExcept(IReadOnlyList<string> excludedConnectionIds) =>
            throw new NotImplementedException();
        public IClientProxy Client(string connectionId) => throw new NotImplementedException();
        public IClientProxy Clients(IReadOnlyList<string> connectionIds) =>
            throw new NotImplementedException();
        public IClientProxy Group(string groupName) => new RecordingClientProxy(_ctx, groupName);
        public IClientProxy GroupExcept(string groupName, IReadOnlyList<string> excludedConnectionIds) =>
            throw new NotImplementedException();
        public IClientProxy Groups(IReadOnlyList<string> groupNames) =>
            throw new NotImplementedException();
        public IClientProxy User(string userId) => throw new NotImplementedException();
        public IClientProxy Users(IReadOnlyList<string> userIds) =>
            throw new NotImplementedException();
    }

    private sealed class RecordingClientProxy : IClientProxy
    {
        private readonly FakeHubContext _ctx;
        private readonly string _group;
        public RecordingClientProxy(FakeHubContext ctx, string group)
        {
            _ctx = ctx;
            _group = group;
        }
        public Task SendCoreAsync(string method, object?[] args, CancellationToken ct = default)
        {
            _ctx.Invocations.Add(new CapturedInvocation(_group, method, args[0]!));
            return Task.CompletedTask;
        }
    }
}
