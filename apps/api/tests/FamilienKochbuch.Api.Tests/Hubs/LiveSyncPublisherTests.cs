using FamilienKochbuch.Api.Hubs;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.Enums;
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
    public async Task RecipeImportProgressChangedAsync_Publishes_Full_Snapshot_To_Group()
    {
        var hub = new FakeHubContext();
        var publisher = new LiveSyncPublisher(hub);

        var import = new RecipeImport(
            userId: Guid.NewGuid(),
            groupId: Guid.NewGuid(),
            source: ImportSource.Url,
            sourceUrl: "https://x",
            createdAt: DateTimeOffset.UtcNow);
        import.UpdateProgress(
            RecipeImportPhase.Transcribing, 40,
            bytesDownloaded: null, bytesTotal: null,
            segmentsDone: 8, segmentsTotal: 20,
            attempt: 1, now: DateTimeOffset.UtcNow);

        await publisher.RecipeImportProgressChangedAsync(import);

        var captured = Assert.Single(hub.Invocations);
        Assert.Equal($"group:{import.GroupId}", captured.GroupName);
        Assert.Equal("RecipeImportProgressChanged", captured.Method);
        var payload = Assert.IsType<RecipeImportProgressPayload>(captured.Argument);
        Assert.Equal(import.Id, payload.ImportId);
        Assert.Equal(import.GroupId, payload.GroupId);
        Assert.Equal("transcribing", payload.Phase);
        Assert.Equal(40, payload.PhaseProgress);
        Assert.Equal(import.Progress, payload.Progress);
        Assert.Equal(8, payload.SegmentsDone);
        Assert.Equal(20, payload.SegmentsTotal);
        Assert.Equal(1, payload.AttemptNumber);
    }

    [Theory]
    [InlineData(RecipeImportPhase.Queued, "queued")]
    [InlineData(RecipeImportPhase.Downloading, "downloading")]
    [InlineData(RecipeImportPhase.Transcribing, "transcribing")]
    [InlineData(RecipeImportPhase.Structuring, "structuring")]
    [InlineData(RecipeImportPhase.PostProcessing, "post_processing")]
    [InlineData(RecipeImportPhase.VisionAnalysis, "vision_analysis")]
    [InlineData(RecipeImportPhase.Done, "done")]
    [InlineData(RecipeImportPhase.Error, "error")]
    public void RecipeImportPhaseWire_ToWire_Matches_Python_Contract(
        RecipeImportPhase phase, string expected)
    {
        Assert.Equal(expected, RecipeImportPhaseWire.ToWire(phase));
    }

    [Fact]
    public void RecipeImportPhaseWire_TryParse_Round_Trips()
    {
        foreach (RecipeImportPhase value in Enum.GetValues(typeof(RecipeImportPhase)))
        {
            var wire = RecipeImportPhaseWire.ToWire(value);
            Assert.True(RecipeImportPhaseWire.TryParse(wire, out var roundTripped));
            Assert.Equal(value, roundTripped);
        }
    }

    [Fact]
    public void RecipeImportPhaseWire_TryParse_Rejects_Unknown()
    {
        Assert.False(RecipeImportPhaseWire.TryParse("not-a-phase", out _));
        Assert.False(RecipeImportPhaseWire.TryParse(null, out _));
        Assert.False(RecipeImportPhaseWire.TryParse("", out _));
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
