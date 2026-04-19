using System.Security.Claims;
using FamilienKochbuch.Infrastructure.Persistence;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;

namespace FamilienKochbuch.Api.Hubs;

/// <summary>
/// P3-8 SignalR hub for live meal-plan + shopping-list sync. The hub is
/// [Authorize]d so anonymous negotiate + WebSocket-upgrade requests are
/// rejected at the auth middleware before reaching the hub class — see
/// <c>Program.cs</c> for the JwtBearer <c>OnMessageReceived</c> wiring
/// that lets the access_token travel in the query string during the
/// WebSocket upgrade.
///
/// On connect the hub enumerates the caller's group memberships and
/// joins one SignalR group per Group (<c>group:{groupId}</c>) so events
/// never leak across group boundaries — the anti-shortcut reminder in
/// the phase-3 plan. On disconnect the group memberships are dropped.
///
/// Tests pin both invariants: anonymous connections are rejected, and
/// a user only receives events from groups they belong to.
/// </summary>
[Authorize]
public class LiveSyncHub : Hub
{
    private readonly AppDbContext _db;
    private readonly ILogger<LiveSyncHub> _logger;

    public LiveSyncHub(AppDbContext db, ILogger<LiveSyncHub> logger)
    {
        _db = db;
        _logger = logger;
    }

    /// <summary>
    /// SignalR group-name for a given Group. Constructing it in one
    /// helper keeps endpoint publishers + hub joins in lockstep.
    /// </summary>
    public static string GroupName(Guid groupId) => $"group:{groupId}";

    public override async Task OnConnectedAsync()
    {
        if (!TryGetUserId(Context.User, out var userId))
        {
            // The [Authorize] attribute should already have bounced
            // unauthenticated connects — this is defence-in-depth in
            // case a test harness or future middleware reshuffle lets
            // a principal through without the expected claim.
            Context.Abort();
            return;
        }

        var groupIds = await _db.GroupMemberships
            .Where(m => m.UserId == userId)
            .Select(m => m.GroupId)
            .ToListAsync(Context.ConnectionAborted);

        foreach (var groupId in groupIds)
        {
            await Groups.AddToGroupAsync(
                Context.ConnectionId,
                GroupName(groupId),
                Context.ConnectionAborted);
        }

        _logger.LogDebug(
            "LiveSyncHub connected: userId={UserId}, groups={GroupCount}, connectionId={ConnectionId}",
            userId, groupIds.Count, Context.ConnectionId);

        await base.OnConnectedAsync();
    }

    /// <summary>
    /// Client-invokable ping used by tests and the frontend to confirm
    /// the hub connection is live (and, incidentally, that
    /// <see cref="OnConnectedAsync"/> has completed its group joins —
    /// SignalR serialises client invocations behind the hub lifecycle,
    /// so a <c>Ping</c> reply guarantees the user is in every group
    /// they belong to). Pure no-op server-side.
    /// </summary>
    public Task<string> Ping() => Task.FromResult("pong");

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        // SignalR auto-removes the connection from all groups when the
        // transport tears down; we just log for observability.
        _logger.LogDebug(
            "LiveSyncHub disconnected: connectionId={ConnectionId}, hadException={HadException}",
            Context.ConnectionId, exception is not null);
        await base.OnDisconnectedAsync(exception);
    }

    private static bool TryGetUserId(ClaimsPrincipal? principal, out Guid userId)
    {
        userId = Guid.Empty;
        if (principal is null) return false;
        var sub = principal.FindFirstValue("sub")
                  ?? principal.FindFirstValue(ClaimTypes.NameIdentifier);
        return Guid.TryParse(sub, out userId);
    }
}
