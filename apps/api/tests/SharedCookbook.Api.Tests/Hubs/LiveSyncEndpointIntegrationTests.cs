using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using SharedCookbook.Api.Endpoints;
using SharedCookbook.Api.Endpoints.MealPlanning;
using SharedCookbook.Api.Hubs;
using SharedCookbook.Api.Tests.Infrastructure;
using SharedCookbook.Domain.MealPlanning;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace SharedCookbook.Api.Tests.Hubs;

/// <summary>
/// Integration coverage for the P3-8 event fan-out: every meal-plan +
/// shopping-list mutation endpoint should publish through
/// <see cref="ILiveSyncPublisher"/>. Rather than spinning up a real
/// SignalR client we swap the publisher for a recording stub so we
/// can assert event name + payload shape in one focused test.
/// </summary>
public class LiveSyncEndpointIntegrationTests
    : IClassFixture<LiveSyncRecordingFactory>, IAsyncLifetime
{
    private static readonly DateOnly CurrentMonday = new(2026, 4, 20);

    private readonly LiveSyncRecordingFactory _factory;
    private HttpClient _client = null!;

    public LiveSyncEndpointIntegrationTests(LiveSyncRecordingFactory factory)
    {
        _factory = factory;
    }

    public Task InitializeAsync()
    {
        _client = _factory.CreateRateLimitBypassingClient(
            new WebApplicationFactoryClientOptions { HandleCookies = true });
        _factory.RecordingPublisher.Reset();
        return Task.CompletedTask;
    }

    public Task DisposeAsync()
    {
        _client.Dispose();
        return Task.CompletedTask;
    }

    // ── Helpers ──────────────────────────────────────────────────────

    private async Task<(Guid UserId, string AccessToken)> SignupAsync(string email)
    {
        using var adminClient = _factory.CreateRateLimitBypassingClient();
        var adminLogin = await adminClient.PostAsJsonAsync("/api/auth/login",
            new AuthEndpoints.LoginRequest("admin@test.local", "AdminPassword123!"));
        adminLogin.EnsureSuccessStatusCode();
        var adminBody = (await adminLogin.Content.ReadFromJsonAsync<AuthEndpoints.AuthResponse>())!;

        using var inviteReq = new HttpRequestMessage(HttpMethod.Post, "/api/invites/app/");
        inviteReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", adminBody.AccessToken);
        inviteReq.Content = JsonContent.Create(new { });
        var inviteRes = await adminClient.SendAsync(inviteReq);
        inviteRes.EnsureSuccessStatusCode();
        var invite = (await inviteRes.Content.ReadFromJsonAsync<InviteEndpoints.CreateInviteResponse>())!;

        using var fresh = _factory.CreateRateLimitBypassingClient();
        var signup = await fresh.PostAsJsonAsync(
            $"/api/auth/signup?token={invite.Token}",
            new AuthEndpoints.SignupRequest(email, "Passwort123!", "Test"));
        signup.EnsureSuccessStatusCode();
        var body = (await signup.Content.ReadFromJsonAsync<AuthEndpoints.AuthResponse>())!;
        return (body.User.Id, body.AccessToken);
    }

    private async Task<Guid> CreateGroupAsync()
    {
        var res = await _client.PostAsJsonAsync("/api/groups",
            new GroupEndpoints.CreateGroupRequest("LiveGrp", null, null));
        res.EnsureSuccessStatusCode();
        var body = (await res.Content.ReadFromJsonAsync<GroupEndpoints.GroupSummaryDto>())!;
        return body.Id;
    }

    // ── Tests ────────────────────────────────────────────────────────

    [Fact]
    public async Task CreateMealPlan_Emits_MealPlanChanged_Created()
    {
        var (_, token) = await SignupAsync("int-create@ex.com");
        _client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var groupId = await CreateGroupAsync();
        _factory.RecordingPublisher.Reset();

        var res = await _client.PostAsJsonAsync(
            $"/api/groups/{groupId}/mealplans",
            new MealPlanEndpoints.CreateMealPlanRequest(CurrentMonday));
        Assert.Equal(HttpStatusCode.Created, res.StatusCode);

        var plan = Assert.Single(_factory.RecordingPublisher.MealPlanChanges);
        Assert.Equal(groupId, plan.GroupId);
        Assert.Equal("2026-04-20", plan.WeekStart);
        Assert.Equal(LiveSyncAction.Created, plan.Action);
    }

    [Fact]
    public async Task AddSlot_Emits_SlotChanged_Created_And_PlanChanged()
    {
        var (_, token) = await SignupAsync("int-addslot@ex.com");
        _client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var groupId = await CreateGroupAsync();
        var plan = (await (await _client.PostAsJsonAsync(
            $"/api/groups/{groupId}/mealplans",
            new MealPlanEndpoints.CreateMealPlanRequest(CurrentMonday)))
            .Content.ReadFromJsonAsync<MealPlanEndpoints.MealPlanDto>())!;

        _factory.RecordingPublisher.Reset();

        var addRes = await _client.PostAsJsonAsync(
            $"/api/mealplans/{plan.Id}/slots",
            new MealPlanEndpoints.AddSlotRequest(
                RecipeId: null, Label: "Restaurant", Date: CurrentMonday,
                Meal: MealSlot.Abend, Servings: 2));
        addRes.EnsureSuccessStatusCode();

        var slotChange = Assert.Single(_factory.RecordingPublisher.SlotChanges);
        Assert.Equal(plan.Id, slotChange.PlanId);
        Assert.Equal(groupId, slotChange.GroupId);
        Assert.Equal(LiveSyncAction.Created, slotChange.Action);

        // The AddSlot handler pairs a slot-changed with a plan-changed
        // (version-bump) event so MealPlan queries invalidate too.
        Assert.Contains(_factory.RecordingPublisher.MealPlanChanges,
            p => p.PlanId == plan.Id && p.Action == LiveSyncAction.Updated);
    }

    [Fact]
    public async Task DeleteSlot_Emits_SlotChanged_Deleted()
    {
        var (_, token) = await SignupAsync("int-delslot@ex.com");
        _client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var groupId = await CreateGroupAsync();
        var plan = (await (await _client.PostAsJsonAsync(
            $"/api/groups/{groupId}/mealplans",
            new MealPlanEndpoints.CreateMealPlanRequest(CurrentMonday)))
            .Content.ReadFromJsonAsync<MealPlanEndpoints.MealPlanDto>())!;
        var slot = (await (await _client.PostAsJsonAsync(
            $"/api/mealplans/{plan.Id}/slots",
            new MealPlanEndpoints.AddSlotRequest(
                RecipeId: null, Label: "Tbd", Date: CurrentMonday,
                Meal: MealSlot.Mittag, Servings: 2)))
            .Content.ReadFromJsonAsync<MealPlanEndpoints.MealPlanSlotDto>())!;

        _factory.RecordingPublisher.Reset();

        var del = await _client.DeleteAsync($"/api/mealplans/{plan.Id}/slots/{slot.Id}");
        Assert.Equal(HttpStatusCode.NoContent, del.StatusCode);

        var slotChange = Assert.Single(_factory.RecordingPublisher.SlotChanges);
        Assert.Equal(slot.Id, slotChange.SlotId);
        Assert.Equal(LiveSyncAction.Deleted, slotChange.Action);
    }

    [Fact]
    public async Task PatchSlot_Emits_SlotChanged_Updated()
    {
        var (_, token) = await SignupAsync("int-patch@ex.com");
        _client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var groupId = await CreateGroupAsync();
        var plan = (await (await _client.PostAsJsonAsync(
            $"/api/groups/{groupId}/mealplans",
            new MealPlanEndpoints.CreateMealPlanRequest(CurrentMonday)))
            .Content.ReadFromJsonAsync<MealPlanEndpoints.MealPlanDto>())!;
        var slot = (await (await _client.PostAsJsonAsync(
            $"/api/mealplans/{plan.Id}/slots",
            new MealPlanEndpoints.AddSlotRequest(
                RecipeId: null, Label: "Tbd", Date: CurrentMonday,
                Meal: MealSlot.Mittag, Servings: 2)))
            .Content.ReadFromJsonAsync<MealPlanEndpoints.MealPlanSlotDto>())!;

        _factory.RecordingPublisher.Reset();

        using var patchReq = new HttpRequestMessage(HttpMethod.Patch,
            $"/api/mealplans/{plan.Id}/slots/{slot.Id}");
        patchReq.Content = new StringContent("{\"servings\": 4}",
            System.Text.Encoding.UTF8, "application/json");
        var patchRes = await _client.SendAsync(patchReq);
        patchRes.EnsureSuccessStatusCode();

        var slotChange = Assert.Single(_factory.RecordingPublisher.SlotChanges);
        Assert.Equal(LiveSyncAction.Updated, slotChange.Action);
    }
}

/// <summary>
/// WAF override that swaps the real <see cref="LiveSyncPublisher"/>
/// with <see cref="RecordingLiveSyncPublisher"/> so the integration
/// tests above can inspect what every endpoint fans out without having
/// to run a real SignalR client side.
/// </summary>
public class LiveSyncRecordingFactory : SharedCookbookWebApplicationFactory
{
    public RecordingLiveSyncPublisher RecordingPublisher { get; } = new();

    protected override void ConfigureWebHost(Microsoft.AspNetCore.Hosting.IWebHostBuilder builder)
    {
        base.ConfigureWebHost(builder);
        builder.ConfigureServices(services =>
        {
            var existing = services.Where(d => d.ServiceType == typeof(ILiveSyncPublisher)).ToList();
            foreach (var d in existing) services.Remove(d);
            services.AddSingleton<ILiveSyncPublisher>(RecordingPublisher);
        });
    }
}

/// <summary>Stub publisher recording every fan-out call in memory.</summary>
public sealed class RecordingLiveSyncPublisher : ILiveSyncPublisher
{
    public record SlotChange(Guid GroupId, Guid PlanId, Guid SlotId, string WeekStart, LiveSyncAction Action);
    public record PlanChange(Guid GroupId, Guid PlanId, string WeekStart, LiveSyncAction Action);
    public record ItemChange(Guid GroupId, Guid PlanId, Guid ListId, Guid ItemId, LiveSyncAction Action);
    public record ImportProgressChange(
        Guid ImportId,
        Guid GroupId,
        SharedCookbook.Domain.Enums.RecipeImportPhase Phase,
        int Progress,
        int PhaseProgress,
        string? ProgressLabel,
        int AttemptNumber);

    private readonly List<SlotChange> _slotChanges = new();
    private readonly List<PlanChange> _planChanges = new();
    private readonly List<ItemChange> _itemChanges = new();
    private readonly List<ImportProgressChange> _importChanges = new();

    public IReadOnlyList<SlotChange> SlotChanges => _slotChanges;
    public IReadOnlyList<PlanChange> MealPlanChanges => _planChanges;
    public IReadOnlyList<ItemChange> ItemChanges => _itemChanges;
    public IReadOnlyList<ImportProgressChange> ImportProgressChanges => _importChanges;

    public void Reset()
    {
        _slotChanges.Clear();
        _planChanges.Clear();
        _itemChanges.Clear();
        _importChanges.Clear();
    }

    public Task MealPlanSlotChangedAsync(
        Guid groupId, Guid planId, Guid slotId, string weekStart,
        LiveSyncAction action, CancellationToken ct = default)
    {
        _slotChanges.Add(new SlotChange(groupId, planId, slotId, weekStart, action));
        return Task.CompletedTask;
    }

    public Task MealPlanChangedAsync(
        Guid groupId, Guid planId, string weekStart, LiveSyncAction action,
        CancellationToken ct = default)
    {
        _planChanges.Add(new PlanChange(groupId, planId, weekStart, action));
        return Task.CompletedTask;
    }

    public Task ShoppingListItemChangedAsync(
        Guid groupId, Guid planId, Guid listId, Guid itemId,
        LiveSyncAction action, CancellationToken ct = default)
    {
        _itemChanges.Add(new ItemChange(groupId, planId, listId, itemId, action));
        return Task.CompletedTask;
    }

    public Task RecipeImportProgressChangedAsync(
        SharedCookbook.Domain.Entities.RecipeImport import,
        CancellationToken ct = default)
    {
        _importChanges.Add(new ImportProgressChange(
            ImportId: import.Id,
            GroupId: import.GroupId,
            Phase: import.Phase,
            Progress: import.Progress,
            PhaseProgress: import.PhaseProgress,
            ProgressLabel: import.ProgressLabel,
            AttemptNumber: import.AttemptNumber));
        return Task.CompletedTask;
    }
}
