using System.Security.Claims;
using FamilienKochbuch.Api.Services;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.Enums;
using FamilienKochbuch.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace FamilienKochbuch.Api.Endpoints;

/// <summary>
/// Groups & Memberships endpoints (S2). All endpoints require
/// authentication; RBAC is enforced per-operation (member/Admin as noted).
/// Error payload shape matches the rest of the API:
/// <c>{ "code": "...", "message": "..." }</c>.
/// </summary>
public static class GroupEndpoints
{
    public const int UserSearchMaxLimit = 20;
    public const int UserSearchDefaultLimit = 10;

    // ── DTO records ─────────────────────────────────────────────────

    public record CreateGroupRequest(string Name, string? Description, decimal? DefaultServings);
    public record UpdateGroupRequest(string? Name, string? Description, decimal? DefaultServings, string? CoverImageUrl);
    public record InviteToGroupRequest(Guid InvitedUserId);
    public record ChangeMemberRoleRequest(string Role);

    public record GroupSummaryDto(
        Guid Id,
        string Name,
        string? Description,
        string? CoverImageUrl,
        decimal DefaultServings,
        bool IsPrivateCollection,
        int MemberCount,
        string MyRole);

    public record GroupMemberDto(Guid UserId, string DisplayName, string Role, DateTimeOffset JoinedAt);

    public record GroupDetailDto(
        Guid Id,
        string Name,
        string? Description,
        string? CoverImageUrl,
        decimal DefaultServings,
        bool IsPrivateCollection,
        int MemberCount,
        string MyRole,
        GroupMemberDto[] Members);

    public record GroupInviteDto(
        Guid Id,
        Guid GroupId,
        Guid InvitedUserId,
        string Status,
        DateTimeOffset CreatedAt);

    public record GroupInviteListItemDto(
        Guid Id,
        Guid GroupId,
        Guid InvitedUserId,
        string InvitedUserDisplayName,
        string Status,
        DateTimeOffset CreatedAt);

    public record ReceivedInviteDto(
        Guid Id,
        Guid GroupId,
        string GroupName,
        string InviterDisplayName,
        DateTimeOffset CreatedAt);

    public record UserSearchResultDto(Guid Id, string DisplayName, string? AvatarUrl);

    // ── Endpoint wiring ─────────────────────────────────────────────

    public static void MapGroupEndpoints(this WebApplication app)
    {
        var groups = app.MapGroup("/api/groups")
            .WithTags("Groups")
            .RequireAuthorization();

        groups.MapPost("/", CreateGroupAsync);
        groups.MapGet("/", ListMyGroupsAsync);
        groups.MapGet("/invites", GetReceivedInvitesAsync);
        groups.MapPost("/invites/{id:guid}/accept", AcceptInviteAsync);
        groups.MapPost("/invites/{id:guid}/decline", DeclineInviteAsync);
        groups.MapGet("/{id:guid}", GetGroupDetailAsync);
        groups.MapPut("/{id:guid}", UpdateGroupAsync);
        groups.MapDelete("/{id:guid}", DeleteGroupAsync);
        groups.MapPost("/{id:guid}/invites", CreateGroupInviteAsync);
        groups.MapGet("/{id:guid}/invites", ListGroupInvitesAsync);
        groups.MapGet("/{id:guid}/members", GetGroupMembersAsync);
        groups.MapPut("/{id:guid}/members/{userId:guid}", ChangeMemberRoleAsync);
        groups.MapDelete("/{id:guid}/members/{userId:guid}", RemoveMemberAsync);

        app.MapGet("/api/users/search", SearchUsersAsync)
            .WithTags("Users")
            .RequireAuthorization();
    }

    // ── Implementations ─────────────────────────────────────────────

    private static async Task<IResult> CreateGroupAsync(
        CreateGroupRequest body,
        ClaimsPrincipal principal,
        AppDbContext db,
        TimeProvider clock,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        Group group;
        try
        {
            var now = clock.GetUtcNow();
            group = new Group(
                name: body.Name,
                description: body.Description,
                createdAt: now,
                defaultServings: body.DefaultServings ?? 2m);
            var membership = new GroupMembership(userId, group.Id, GroupRole.Admin, now);
            db.Groups.Add(group);
            db.GroupMemberships.Add(membership);
            await db.SaveChangesAsync(ct);
        }
        catch (ArgumentException ex)
        {
            return FamilienResults.BadRequest("invalid_input", ex.Message);
        }

        var summary = await LoadSummaryAsync(db, group.Id, userId, ct);
        return Results.Created($"/api/groups/{group.Id}", summary);
    }

    private static async Task<IResult> ListMyGroupsAsync(
        ClaimsPrincipal principal,
        AppDbContext db,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var entries = await db.GroupMemberships
            .Where(m => m.UserId == userId)
            .Join(db.Groups.Where(g => g.DeletedAt == null),
                m => m.GroupId, g => g.Id,
                (m, g) => new { Membership = m, Group = g })
            .Select(x => new
            {
                x.Group,
                x.Membership.Role,
                MemberCount = db.GroupMemberships.Count(gm => gm.GroupId == x.Group.Id),
            })
            .ToListAsync(ct);

        var results = entries
            .Select(e => new GroupSummaryDto(
                e.Group.Id, e.Group.Name, e.Group.Description, e.Group.CoverImageUrl,
                e.Group.DefaultServings, e.Group.IsPrivateCollection,
                e.MemberCount, e.Role.ToString()))
            .OrderByDescending(g => g.IsPrivateCollection)
            .ThenBy(g => g.Name, StringComparer.CurrentCulture)
            .ToArray();

        return Results.Ok(results);
    }

    private static async Task<IResult> GetGroupDetailAsync(
        Guid id,
        ClaimsPrincipal principal,
        AppDbContext db,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var group = await db.Groups.FirstOrDefaultAsync(g => g.Id == id && g.DeletedAt == null, ct);
        if (group is null) return Results.NotFound();

        var myMembership = await db.GroupMemberships
            .FirstOrDefaultAsync(m => m.GroupId == id && m.UserId == userId, ct);
        if (myMembership is null) return Results.Forbid();

        var members = await db.GroupMemberships
            .Where(m => m.GroupId == id)
            .Join(db.Users, m => m.UserId, u => u.Id, (m, u) =>
                new GroupMemberDto(u.Id, u.DisplayName, m.Role.ToString(), m.JoinedAt))
            .ToListAsync(ct);

        var detail = new GroupDetailDto(
            group.Id, group.Name, group.Description, group.CoverImageUrl,
            group.DefaultServings, group.IsPrivateCollection,
            members.Count, myMembership.Role.ToString(),
            members.OrderBy(m => m.DisplayName, StringComparer.CurrentCulture).ToArray());

        return Results.Ok(detail);
    }

    private static async Task<IResult> UpdateGroupAsync(
        Guid id,
        UpdateGroupRequest body,
        ClaimsPrincipal principal,
        AppDbContext db,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var group = await db.Groups.FirstOrDefaultAsync(g => g.Id == id && g.DeletedAt == null, ct);
        if (group is null) return Results.NotFound();

        var myMembership = await db.GroupMemberships
            .FirstOrDefaultAsync(m => m.GroupId == id && m.UserId == userId, ct);
        if (myMembership is null) return Results.Forbid();
        if (myMembership.Role != GroupRole.Admin) return Results.Forbid();

        try
        {
            group.UpdateMetadata(body.Name, body.Description, body.DefaultServings, body.CoverImageUrl);
        }
        catch (ArgumentException ex)
        {
            return FamilienResults.BadRequest("invalid_input", ex.Message);
        }

        await db.SaveChangesAsync(ct);
        var summary = await LoadSummaryAsync(db, group.Id, userId, ct);
        return Results.Ok(summary);
    }

    private static async Task<IResult> DeleteGroupAsync(
        Guid id,
        ClaimsPrincipal principal,
        AppDbContext db,
        TimeProvider clock,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var group = await db.Groups.FirstOrDefaultAsync(g => g.Id == id && g.DeletedAt == null, ct);
        if (group is null) return Results.NotFound();

        var myMembership = await db.GroupMemberships
            .FirstOrDefaultAsync(m => m.GroupId == id && m.UserId == userId, ct);
        if (myMembership is null || myMembership.Role != GroupRole.Admin)
            return Results.Forbid();

        if (group.IsPrivateCollection)
            return FamilienResults.BadRequest(
                "private_collection_protected",
                "Die Private Sammlung kann nicht gelöscht werden.");

        group.SoftDelete(clock.GetUtcNow());
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    // ── Invites ─────────────────────────────────────────────────────

    private static async Task<IResult> CreateGroupInviteAsync(
        Guid id,
        InviteToGroupRequest body,
        ClaimsPrincipal principal,
        AppDbContext db,
        TimeProvider clock,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var group = await db.Groups.FirstOrDefaultAsync(g => g.Id == id && g.DeletedAt == null, ct);
        if (group is null) return Results.NotFound();

        var amMember = await db.GroupMemberships
            .AnyAsync(m => m.GroupId == id && m.UserId == userId, ct);
        if (!amMember) return Results.Forbid();

        if (body.InvitedUserId == Guid.Empty)
            return FamilienResults.BadRequest("invalid_input", "invitedUserId fehlt.");
        if (body.InvitedUserId == userId)
            return FamilienResults.BadRequest("invalid_input", "Du kannst dich nicht selbst einladen.");

        var invitedExists = await db.Users.AnyAsync(u => u.Id == body.InvitedUserId, ct);
        if (!invitedExists)
            return FamilienResults.BadRequest("user_not_found", "Nutzer:in nicht gefunden.");

        var alreadyMember = await db.GroupMemberships
            .AnyAsync(m => m.GroupId == id && m.UserId == body.InvitedUserId, ct);
        if (alreadyMember)
            return FamilienResults.BadRequest("already_member", "Nutzer:in ist bereits Mitglied.");

        var alreadyPending = await db.GroupInvites
            .AnyAsync(i => i.GroupId == id
                           && i.InvitedUserId == body.InvitedUserId
                           && i.Status == InviteStatus.Pending, ct);
        if (alreadyPending)
            return FamilienResults.BadRequest("invite_pending", "Es gibt bereits eine offene Einladung.");

        var invite = new GroupInvite(id, userId, body.InvitedUserId, clock.GetUtcNow());
        db.GroupInvites.Add(invite);
        await db.SaveChangesAsync(ct);

        return Results.Created($"/api/groups/invites/{invite.Id}",
            new GroupInviteDto(invite.Id, invite.GroupId, invite.InvitedUserId,
                invite.Status.ToString(), invite.CreatedAt));
    }

    /// <summary>
    /// Admin-only listing of outstanding (Pending) invites for a group. Used
    /// by the group-admin UI to show and revoke outgoing invites. Accepted /
    /// Declined invites are filtered out at the query layer so the panel
    /// only shows actionable entries.
    /// </summary>
    private static async Task<IResult> ListGroupInvitesAsync(
        Guid id,
        ClaimsPrincipal principal,
        AppDbContext db,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var group = await db.Groups.FirstOrDefaultAsync(g => g.Id == id && g.DeletedAt == null, ct);
        if (group is null) return Results.NotFound();

        var myMembership = await db.GroupMemberships
            .FirstOrDefaultAsync(m => m.GroupId == id && m.UserId == userId, ct);
        if (myMembership is null || myMembership.Role != GroupRole.Admin)
            return Results.Forbid();

        var rows = await db.GroupInvites
            .Where(i => i.GroupId == id && i.Status == InviteStatus.Pending)
            .Join(db.Users, i => i.InvitedUserId, u => u.Id,
                (i, u) => new { i.Id, i.GroupId, i.InvitedUserId, u.DisplayName, i.Status, i.CreatedAt })
            .ToListAsync(ct);

        // SQLite can't ORDER BY DateTimeOffset and Npgsql handles it fine;
        // we materialize first and sort in LINQ-to-Objects so the query
        // translates identically on both providers.
        var invites = rows
            .OrderByDescending(x => x.CreatedAt)
            .Select(x => new GroupInviteListItemDto(
                x.Id, x.GroupId, x.InvitedUserId, x.DisplayName,
                x.Status.ToString(), x.CreatedAt))
            .ToArray();

        return Results.Ok(invites);
    }

    private static async Task<IResult> GetReceivedInvitesAsync(
        ClaimsPrincipal principal,
        AppDbContext db,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var invites = await db.GroupInvites
            .Where(i => i.InvitedUserId == userId && i.Status == InviteStatus.Pending)
            .Join(db.Groups, i => i.GroupId, g => g.Id, (i, g) => new { Invite = i, Group = g })
            .Join(db.Users, x => x.Invite.InvitedByUserId, u => u.Id,
                (x, u) => new ReceivedInviteDto(
                    x.Invite.Id, x.Group.Id, x.Group.Name, u.DisplayName, x.Invite.CreatedAt))
            .ToListAsync(ct);

        return Results.Ok(invites);
    }

    private static async Task<IResult> AcceptInviteAsync(
        Guid id,
        ClaimsPrincipal principal,
        AppDbContext db,
        TimeProvider clock,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var invite = await db.GroupInvites.FirstOrDefaultAsync(i => i.Id == id, ct);
        if (invite is null) return Results.NotFound();
        if (invite.InvitedUserId != userId) return Results.Forbid();
        if (invite.Status != InviteStatus.Pending)
            return FamilienResults.BadRequest("invite_not_pending", "Einladung bereits beantwortet.");

        var now = clock.GetUtcNow();
        invite.Accept(now);

        var alreadyMember = await db.GroupMemberships
            .AnyAsync(m => m.GroupId == invite.GroupId && m.UserId == userId, ct);
        if (!alreadyMember)
        {
            var membership = new GroupMembership(userId, invite.GroupId, GroupRole.Member, now);
            db.GroupMemberships.Add(membership);
        }

        await db.SaveChangesAsync(ct);

        return Results.Ok(new GroupInviteDto(
            invite.Id, invite.GroupId, invite.InvitedUserId, invite.Status.ToString(), invite.CreatedAt));
    }

    private static async Task<IResult> DeclineInviteAsync(
        Guid id,
        ClaimsPrincipal principal,
        AppDbContext db,
        TimeProvider clock,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var invite = await db.GroupInvites.FirstOrDefaultAsync(i => i.Id == id, ct);
        if (invite is null) return Results.NotFound();
        if (invite.InvitedUserId != userId) return Results.Forbid();
        if (invite.Status != InviteStatus.Pending)
            return FamilienResults.BadRequest("invite_not_pending", "Einladung bereits beantwortet.");

        invite.Decline(clock.GetUtcNow());
        await db.SaveChangesAsync(ct);

        return Results.Ok(new GroupInviteDto(
            invite.Id, invite.GroupId, invite.InvitedUserId, invite.Status.ToString(), invite.CreatedAt));
    }

    // ── Members ─────────────────────────────────────────────────────

    private static async Task<IResult> GetGroupMembersAsync(
        Guid id,
        ClaimsPrincipal principal,
        AppDbContext db,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var amMember = await db.GroupMemberships
            .AnyAsync(m => m.GroupId == id && m.UserId == userId, ct);
        if (!amMember) return Results.Forbid();

        var members = await db.GroupMemberships
            .Where(m => m.GroupId == id)
            .Join(db.Users, m => m.UserId, u => u.Id, (m, u) =>
                new GroupMemberDto(u.Id, u.DisplayName, m.Role.ToString(), m.JoinedAt))
            .ToListAsync(ct);

        return Results.Ok(members
            .OrderBy(m => m.DisplayName, StringComparer.CurrentCulture)
            .ToArray());
    }

    private static async Task<IResult> ChangeMemberRoleAsync(
        Guid id,
        Guid userId,
        ChangeMemberRoleRequest body,
        ClaimsPrincipal principal,
        AppDbContext db,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var actingUserId)) return Results.Unauthorized();

        var myMembership = await db.GroupMemberships
            .FirstOrDefaultAsync(m => m.GroupId == id && m.UserId == actingUserId, ct);
        if (myMembership is null || myMembership.Role != GroupRole.Admin)
            return Results.Forbid();

        if (!Enum.TryParse<GroupRole>(body.Role, ignoreCase: false, out var targetRole))
            return FamilienResults.BadRequest("invalid_input", "Unbekannte Rolle.");

        var target = await db.GroupMemberships
            .FirstOrDefaultAsync(m => m.GroupId == id && m.UserId == userId, ct);
        if (target is null) return Results.NotFound();

        if (target.Role == GroupRole.Admin && targetRole == GroupRole.Member)
        {
            var adminCount = await db.GroupMemberships
                .CountAsync(m => m.GroupId == id && m.Role == GroupRole.Admin, ct);
            if (adminCount <= 1)
                return FamilienResults.BadRequest(
                    "last_admin",
                    "Die Gruppe muss mindestens eine:n Admin behalten.");
        }

        target.ChangeRole(targetRole);
        await db.SaveChangesAsync(ct);

        var user = await db.Users.SingleAsync(u => u.Id == userId, ct);
        return Results.Ok(new GroupMemberDto(user.Id, user.DisplayName, target.Role.ToString(), target.JoinedAt));
    }

    private static async Task<IResult> RemoveMemberAsync(
        Guid id,
        Guid userId,
        ClaimsPrincipal principal,
        AppDbContext db,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var actingUserId)) return Results.Unauthorized();

        var group = await db.Groups.FirstOrDefaultAsync(g => g.Id == id, ct);
        if (group is null) return Results.NotFound();

        var myMembership = await db.GroupMemberships
            .FirstOrDefaultAsync(m => m.GroupId == id && m.UserId == actingUserId, ct);
        if (myMembership is null) return Results.Forbid();

        var isSelf = actingUserId == userId;
        if (!isSelf && myMembership.Role != GroupRole.Admin) return Results.Forbid();

        // PRD §4.4: Private Sammlung has a reserved single member; the record
        // cannot be removed (the group is never-deletable for the same reason).
        if (group.IsPrivateCollection)
            return FamilienResults.BadRequest(
                "private_collection_protected",
                "Private Sammlung kann nicht verlassen werden.");

        var target = await db.GroupMemberships
            .FirstOrDefaultAsync(m => m.GroupId == id && m.UserId == userId, ct);
        if (target is null) return Results.NotFound();

        if (target.Role == GroupRole.Admin)
        {
            var adminCount = await db.GroupMemberships
                .CountAsync(m => m.GroupId == id && m.Role == GroupRole.Admin, ct);
            if (adminCount <= 1)
                return FamilienResults.BadRequest(
                    "last_admin",
                    "Die Gruppe muss mindestens eine:n Admin behalten.");
        }

        db.GroupMemberships.Remove(target);
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    // ── User search ─────────────────────────────────────────────────

    private static async Task<IResult> SearchUsersAsync(
        string? q,
        Guid? excludeGroupId,
        int? limit,
        ClaimsPrincipal principal,
        AppDbContext db,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var needle = (q ?? string.Empty).Trim();
        if (needle.Length == 0)
            return Results.Ok(Array.Empty<UserSearchResultDto>());

        var take = Math.Min(
            Math.Max(limit ?? UserSearchDefaultLimit, 1),
            UserSearchMaxLimit);

        var lowered = needle.ToLowerInvariant();
        var query = db.Users
            .Where(u => u.Id != userId && u.DeletedAt == null)
            .Where(u => u.DisplayName.ToLower().Contains(lowered));

        if (excludeGroupId is Guid groupId && groupId != Guid.Empty)
        {
            var memberIds = db.GroupMemberships
                .Where(m => m.GroupId == groupId)
                .Select(m => m.UserId);
            query = query.Where(u => !memberIds.Contains(u.Id));
        }

        var results = await query
            .OrderBy(u => u.DisplayName)
            .Take(take)
            .Select(u => new UserSearchResultDto(u.Id, u.DisplayName, null))
            .ToListAsync(ct);

        return Results.Ok(results);
    }

    // ── helpers ─────────────────────────────────────────────────────

    private static async Task<GroupSummaryDto> LoadSummaryAsync(AppDbContext db, Guid groupId, Guid userId, CancellationToken ct)
    {
        var group = await db.Groups.SingleAsync(g => g.Id == groupId, ct);
        var myMembership = await db.GroupMemberships
            .SingleAsync(m => m.GroupId == groupId && m.UserId == userId, ct);
        var memberCount = await db.GroupMemberships.CountAsync(m => m.GroupId == groupId, ct);

        return new GroupSummaryDto(
            group.Id, group.Name, group.Description, group.CoverImageUrl,
            group.DefaultServings, group.IsPrivateCollection,
            memberCount, myMembership.Role.ToString());
    }

    private static bool TryGetUserId(ClaimsPrincipal principal, out Guid userId)
    {
        userId = Guid.Empty;
        var sub = principal.FindFirstValue("sub")
                  ?? principal.FindFirstValue(ClaimTypes.NameIdentifier);
        return Guid.TryParse(sub, out userId);
    }
}
