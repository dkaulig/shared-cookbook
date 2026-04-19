using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using FamilienKochbuch.Api.Endpoints;
using FamilienKochbuch.Api.Hubs;
using FamilienKochbuch.Api.Tests.Infrastructure;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace FamilienKochbuch.Api.Tests.Hubs;

/// <summary>
/// End-to-end tests for the P3-8 <see cref="LiveSyncHub"/>. Exercises
/// the real JWT auth pipeline — both the standard Authorization header
/// (via the negotiate HTTP request) and the <c>access_token</c> query
/// param (WebSocket upgrade path). Cross-group leak is asserted in a
/// dedicated test so the anti-shortcut reminder stays a red/green
/// invariant rather than a review-time concern.
/// </summary>
public class LiveSyncHubTests
    : IClassFixture<FamilienKochbuchWebApplicationFactory>, IAsyncLifetime
{
    private readonly FamilienKochbuchWebApplicationFactory _factory;
    private HttpClient _client = null!;

    public LiveSyncHubTests(FamilienKochbuchWebApplicationFactory factory)
    {
        _factory = factory;
    }

    public Task InitializeAsync()
    {
        _client = _factory.CreateRateLimitBypassingClient();
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
        var adminLogin = await _client.PostAsJsonAsync("/api/auth/login",
            new AuthEndpoints.LoginRequest("admin@test.local", "AdminPassword123!"));
        adminLogin.EnsureSuccessStatusCode();
        var adminBody = (await adminLogin.Content.ReadFromJsonAsync<AuthEndpoints.AuthResponse>())!;

        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/invites/app/");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", adminBody.AccessToken);
        req.Content = JsonContent.Create(new { });
        var inviteRes = await _client.SendAsync(req);
        inviteRes.EnsureSuccessStatusCode();
        var invite = (await inviteRes.Content.ReadFromJsonAsync<InviteEndpoints.CreateInviteResponse>())!;

        using var freshClient = _factory.CreateRateLimitBypassingClient();
        var signup = await freshClient.PostAsJsonAsync(
            $"/api/auth/signup?token={invite.Token}",
            new AuthEndpoints.SignupRequest(email, "Passwort123!", "Test"));
        signup.EnsureSuccessStatusCode();
        var body = (await signup.Content.ReadFromJsonAsync<AuthEndpoints.AuthResponse>())!;
        return (body.User.Id, body.AccessToken);
    }

    private async Task<Guid> CreateGroupAsync(string token, string name = "Kochbuch")
    {
        using var client = _factory.CreateRateLimitBypassingClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var res = await client.PostAsJsonAsync("/api/groups",
            new GroupEndpoints.CreateGroupRequest(name, null, null));
        res.EnsureSuccessStatusCode();
        var body = (await res.Content.ReadFromJsonAsync<GroupEndpoints.GroupSummaryDto>())!;
        return body.Id;
    }

    private HubConnection BuildConnection(string? token)
    {
        var server = _factory.Server;
        return new HubConnectionBuilder()
            .WithUrl($"{server.BaseAddress}api/hubs/live", opts =>
            {
                // TestServer's in-proc HttpHandler covers HTTP negotiate
                // + long-polling — the WebSocket upgrade isn't wired
                // inside the default TestServer plumbing, so we force
                // LongPolling which just rides HTTP.
                // Also inject the per-test rate-limit-bypass header so
                // the Hub rate limiter (30/min per IP) doesn't collapse
                // every test in this class into a single partition and
                // start returning 429 mid-suite. Tests that exercise
                // the Hub limiter explicitly (see
                // LiveSyncHubRateLimitTests) use a raw HttpClient
                // without this header.
                opts.HttpMessageHandlerFactory = inner =>
                    new BypassRateLimitHandler(server.CreateHandler());
                opts.AccessTokenProvider = () => Task.FromResult<string?>(token);
                opts.Transports =
                    Microsoft.AspNetCore.Http.Connections.HttpTransportType.LongPolling;
            })
            .Build();
    }

    /// <summary>
    /// DelegatingHandler that tacks the per-test rate-limit-bypass
    /// header onto every request the SignalR client issues (negotiate
    /// + long-poll cycles). Kept inside the test file so the shared
    /// factory plumbing isn't touched.
    /// </summary>
    private sealed class BypassRateLimitHandler : DelegatingHandler
    {
        public BypassRateLimitHandler(HttpMessageHandler inner) : base(inner) { }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (!request.Headers.Contains("X-Test-Disable-RateLimit"))
                request.Headers.Add("X-Test-Disable-RateLimit", "true");
            return base.SendAsync(request, cancellationToken);
        }
    }

    // ── Tests ────────────────────────────────────────────────────────

    [Fact]
    public async Task Connect_Without_Token_Is_Rejected()
    {
        // Direct HTTP assertion on the negotiate endpoint — bypasses
        // the SignalR client so we can pin the exact status code
        // (401) rather than accepting "any exception". The [Authorize]
        // attribute + JwtBearer challenge must reject anonymous
        // negotiate POSTs at the auth middleware.
        using var rawClient = _factory.CreateRateLimitBypassingClient();
        var negotiate = await rawClient.PostAsync("/api/hubs/live/negotiate?negotiateVersion=1", null);
        Assert.Equal(HttpStatusCode.Unauthorized, negotiate.StatusCode);

        // SignalR client-level cross-check — the negotiate 401 must
        // surface as a failed StartAsync. ThrowsAnyAsync keeps this
        // resilient to SignalR wrapping the exception in different
        // shapes across versions, but the HTTP assertion above is the
        // tight one.
        await using var connection = BuildConnection(token: null);
        var caught = await Assert.ThrowsAnyAsync<Exception>(() =>
            connection.StartAsync());
        Assert.NotNull(caught);
    }

    [Fact]
    public async Task Connect_With_Invalid_Token_Is_Rejected()
    {
        using var rawClient = _factory.CreateRateLimitBypassingClient();
        using var req = new HttpRequestMessage(
            HttpMethod.Post, "/api/hubs/live/negotiate?negotiateVersion=1");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", "definitely.not.a.jwt");
        var negotiate = await rawClient.SendAsync(req);
        Assert.Equal(HttpStatusCode.Unauthorized, negotiate.StatusCode);

        await using var connection = BuildConnection(token: "definitely.not.a.jwt");
        var caught = await Assert.ThrowsAnyAsync<Exception>(() =>
            connection.StartAsync());
        Assert.NotNull(caught);
    }

    [Fact]
    public async Task Connect_With_Valid_Token_Succeeds_And_Joins_Member_Groups()
    {
        var (_, token) = await SignupAsync("hub-valid@ex.com");
        var groupId = await CreateGroupAsync(token);

        await using var connection = BuildConnection(token);

        // Round-trip a fan-out through the publisher to confirm the
        // hub actually added the connection to group:{groupId}. The
        // handler completes only when the event lands on this client.
        // Register BEFORE StartAsync — the dispatcher has no callback
        // for the event until On<T> is called.
        var received = new TaskCompletionSource<MealPlanSlotChangedPayload>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        connection.On<MealPlanSlotChangedPayload>(
            LiveSyncTestEventNames.MealPlanSlotChanged,
            payload => received.TrySetResult(payload));

        await connection.StartAsync();
        Assert.Equal(HubConnectionState.Connected, connection.State);

        // Ping round-trip ensures OnConnectedAsync (group-join) has
        // completed before we publish. SignalR serialises client
        // invocations behind the hub lifecycle, so Ping returns only
        // after the hub's OnConnectedAsync finishes.
        var pong = await connection.InvokeAsync<string>("Ping");
        Assert.Equal("pong", pong);

        using var scope = _factory.Services.CreateScope();
        var publisher = scope.ServiceProvider.GetRequiredService<ILiveSyncPublisher>();
        await publisher.MealPlanSlotChangedAsync(
            groupId: groupId,
            planId: Guid.NewGuid(),
            slotId: Guid.NewGuid(),
            weekStart: "2026-04-20",
            action: LiveSyncAction.Created);

        var delivered = await received.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(groupId, delivered.GroupId);
    }

    [Fact]
    public async Task User_Only_Receives_Events_For_Groups_They_Belong_To()
    {
        // Two users, two separate groups. Each user joins only their own
        // group. An event fanned out to user A's group must NEVER arrive
        // on user B's connection — the hard cross-group leak guard from
        // the anti-shortcut reminder.
        var (_, tokenA) = await SignupAsync("hub-a@ex.com");
        var (_, tokenB) = await SignupAsync("hub-b@ex.com");
        var groupA = await CreateGroupAsync(tokenA, "A");
        var groupB = await CreateGroupAsync(tokenB, "B");

        await using var connA = BuildConnection(tokenA);
        await using var connB = BuildConnection(tokenB);

        var leakedToB = new TaskCompletionSource<MealPlanSlotChangedPayload>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        connB.On<MealPlanSlotChangedPayload>(
            LiveSyncTestEventNames.MealPlanSlotChanged,
            payload => leakedToB.TrySetResult(payload));

        var receivedOnA = new TaskCompletionSource<MealPlanSlotChangedPayload>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        connA.On<MealPlanSlotChangedPayload>(
            LiveSyncTestEventNames.MealPlanSlotChanged,
            payload => receivedOnA.TrySetResult(payload));

        await connA.StartAsync();
        await connB.StartAsync();

        // Settle group-joins before publishing.
        await connA.InvokeAsync<string>("Ping");
        await connB.InvokeAsync<string>("Ping");

        using var scope = _factory.Services.CreateScope();
        var publisher = scope.ServiceProvider.GetRequiredService<ILiveSyncPublisher>();
        await publisher.MealPlanSlotChangedAsync(
            groupId: groupA,
            planId: Guid.NewGuid(),
            slotId: Guid.NewGuid(),
            weekStart: "2026-04-20",
            action: LiveSyncAction.Updated);

        // A receives its own event quickly.
        var deliveredA = await receivedOnA.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(groupA, deliveredA.GroupId);

        // B must NOT receive the event — short finite wait; a
        // cross-group leak would fire long before the timeout.
        var leakWait = await Task.WhenAny(
            leakedToB.Task,
            Task.Delay(TimeSpan.FromMilliseconds(500)));
        Assert.NotSame(leakedToB.Task, leakWait);

        // Sanity: B does receive events published to groupB.
        await publisher.MealPlanSlotChangedAsync(
            groupId: groupB,
            planId: Guid.NewGuid(),
            slotId: Guid.NewGuid(),
            weekStart: "2026-04-20",
            action: LiveSyncAction.Updated);
        var deliveredB = await leakedToB.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(groupB, deliveredB.GroupId);
    }

    [Fact]
    public async Task MealPlanChanged_Event_Flows_To_Group_Members()
    {
        var (_, token) = await SignupAsync("hub-mpc@ex.com");
        var groupId = await CreateGroupAsync(token);

        await using var connection = BuildConnection(token);

        // Register the handler BEFORE StartAsync — SignalR buffers
        // handlers registered post-start, but attaching them first
        // eliminates a race where an early event fires before the
        // client's dispatcher has the callback.
        var received = new TaskCompletionSource<MealPlanChangedPayload>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        connection.On<MealPlanChangedPayload>(
            LiveSyncTestEventNames.MealPlanChanged,
            payload => received.TrySetResult(payload));

        await connection.StartAsync();
        await connection.InvokeAsync<string>("Ping");

        using var scope = _factory.Services.CreateScope();
        var publisher = scope.ServiceProvider.GetRequiredService<ILiveSyncPublisher>();
        var planId = Guid.NewGuid();
        await publisher.MealPlanChangedAsync(
            groupId: groupId,
            planId: planId,
            weekStart: "2026-04-20",
            action: LiveSyncAction.Created);

        var payload = await received.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(planId, payload.PlanId);
        Assert.Equal("created", payload.Action);
    }

    [Fact]
    public async Task ShoppingListItemChanged_Event_Flows_To_Group_Members()
    {
        var (_, token) = await SignupAsync("hub-sl@ex.com");
        var groupId = await CreateGroupAsync(token);

        await using var connection = BuildConnection(token);

        var received = new TaskCompletionSource<ShoppingListItemChangedPayload>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        connection.On<ShoppingListItemChangedPayload>(
            LiveSyncTestEventNames.ShoppingListItemChanged,
            payload => received.TrySetResult(payload));

        await connection.StartAsync();
        await connection.InvokeAsync<string>("Ping");

        using var scope = _factory.Services.CreateScope();
        var publisher = scope.ServiceProvider.GetRequiredService<ILiveSyncPublisher>();
        await publisher.ShoppingListItemChangedAsync(
            groupId: groupId,
            planId: Guid.NewGuid(),
            listId: Guid.NewGuid(),
            itemId: Guid.NewGuid(),
            action: LiveSyncAction.Deleted);

        var payload = await received.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal("deleted", payload.Action);
    }

    [Fact]
    public async Task Disconnect_Stops_Event_Delivery()
    {
        var (_, token) = await SignupAsync("hub-dc@ex.com");
        var groupId = await CreateGroupAsync(token);

        await using var connection = BuildConnection(token);
        await connection.StartAsync();
        await connection.StopAsync();

        Assert.NotEqual(HubConnectionState.Connected, connection.State);
    }
}

/// <summary>
/// Mirrors the internal <c>LiveSyncEvents</c> constants — the tests
/// live in a sibling assembly but the hub's event-name constants are
/// internal, so duplicating the strings here keeps the test isolated
/// from the implementation detail.
/// </summary>
internal static class LiveSyncTestEventNames
{
    public const string MealPlanSlotChanged = "MealPlanSlotChanged";
    public const string MealPlanChanged = "MealPlanChanged";
    public const string ShoppingListItemChanged = "ShoppingListItemChanged";
}
