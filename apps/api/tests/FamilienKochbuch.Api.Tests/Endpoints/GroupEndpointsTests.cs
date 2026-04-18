using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using FamilienKochbuch.Api.Endpoints;
using FamilienKochbuch.Api.Tests.Infrastructure;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.Enums;
using FamilienKochbuch.Infrastructure.Persistence;
using FamilienKochbuch.Infrastructure.Services;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace FamilienKochbuch.Api.Tests.Endpoints;

/// <summary>
/// End-to-end tests for the S2 /api/groups endpoints. Each test signs in a
/// user via the real /api/auth/login flow so RBAC is exercised against the
/// actual JWT middleware. SQLite in-memory backs the DbContext.
/// </summary>
public class GroupEndpointsTests : IClassFixture<FamilienKochbuchWebApplicationFactory>, IAsyncLifetime
{
    private readonly FamilienKochbuchWebApplicationFactory _factory;
    private HttpClient _client = null!;

    public GroupEndpointsTests(FamilienKochbuchWebApplicationFactory factory)
    {
        _factory = factory;
    }

    public async Task InitializeAsync()
    {
        _client = _factory.CreateRateLimitBypassingClient(
            new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { HandleCookies = true });
        _factory.Email.Clear();
        await ResetDatabaseAsync();
    }

    public Task DisposeAsync()
    {
        _client.Dispose();
        return Task.CompletedTask;
    }

    private async Task ResetDatabaseAsync()
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        db.GroupInvites.RemoveRange(db.GroupInvites);
        db.GroupMemberships.RemoveRange(db.GroupMemberships);
        db.Groups.RemoveRange(db.Groups);
        db.RefreshTokens.RemoveRange(db.RefreshTokens);
        db.AppInvites.RemoveRange(db.AppInvites);
        var nonAdmin = db.Users.Where(u => u.Email != "admin@test.local");
        db.Users.RemoveRange(nonAdmin);
        await db.SaveChangesAsync();

        // Re-seed the admin's Private Sammlung (initial startup seed only
        // runs on first boot; test DB reset between runs clears it).
        var adminId = await db.Users.Where(u => u.Email == "admin@test.local").Select(u => u.Id).SingleAsync();
        var privateCollections = scope.ServiceProvider.GetRequiredService<IPrivateCollectionService>();
        await privateCollections.EnsurePrivateCollectionAsync(adminId);
    }

    // ── helpers ─────────────────────────────────────────────────────

    private async Task<(Guid UserId, string AccessToken)> SignupAndLoginAsync(string email, string displayName)
    {
        // Admin creates an app invite.
        var adminToken = (await LoginAsync("admin@test.local", "AdminPassword123!")).AccessToken;
        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/invites/app/");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", adminToken);
        req.Content = JsonContent.Create(new { });
        var inviteRes = await _client.SendAsync(req);
        inviteRes.EnsureSuccessStatusCode();
        var invite = await inviteRes.Content.ReadFromJsonAsync<InviteEndpoints.CreateInviteResponse>();

        using var freshClient = _factory.CreateRateLimitBypassingClient(
            new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { HandleCookies = true });
        var signup = await freshClient.PostAsJsonAsync(
            $"/api/auth/signup?token={invite!.Token}",
            new AuthEndpoints.SignupRequest(email, "Passwort123!", displayName));
        signup.EnsureSuccessStatusCode();
        var body = await signup.Content.ReadFromJsonAsync<AuthEndpoints.AuthResponse>();
        return (body!.User.Id, body.AccessToken);
    }

    private async Task<AuthEndpoints.AuthResponse> LoginAsync(string email, string password)
    {
        using var client = _factory.CreateRateLimitBypassingClient(
            new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { HandleCookies = true });
        var response = await client.PostAsJsonAsync("/api/auth/login",
            new AuthEndpoints.LoginRequest(email, password));
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadFromJsonAsync<AuthEndpoints.AuthResponse>())!;
    }

    private static void AuthorizeClient(HttpClient client, string accessToken) =>
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);

    // ── POST /api/groups ────────────────────────────────────────────

    [Fact]
    public async Task CreateGroup_Returns_201_And_Marks_Creator_Admin()
    {
        var (_, accessToken) = await SignupAndLoginAsync("alice@example.com", "Alice");
        AuthorizeClient(_client, accessToken);

        var response = await _client.PostAsJsonAsync(
            "/api/groups",
            new GroupEndpoints.CreateGroupRequest("Example Family", "Unsere Sammlung", 4m));

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<GroupEndpoints.GroupSummaryDto>();
        Assert.NotNull(body);
        Assert.Equal("Example Family", body!.Name);
        Assert.Equal("Unsere Sammlung", body.Description);
        Assert.Equal(4m, body.DefaultServings);
        Assert.False(body.IsPrivateCollection);
        Assert.Equal("Admin", body.MyRole);
        Assert.Equal(1, body.MemberCount);
    }

    [Fact]
    public async Task CreateGroup_Requires_Authentication()
    {
        var response = await _client.PostAsJsonAsync(
            "/api/groups",
            new GroupEndpoints.CreateGroupRequest("X", null, null));

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task CreateGroup_Rejects_Blank_Name()
    {
        var (_, accessToken) = await SignupAndLoginAsync("blank@example.com", "Blank");
        AuthorizeClient(_client, accessToken);

        var response = await _client.PostAsJsonAsync(
            "/api/groups",
            new GroupEndpoints.CreateGroupRequest("   ", null, null));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    // ── GET /api/groups ─────────────────────────────────────────────

    [Fact]
    public async Task ListMyGroups_Includes_PrivateSammlung_And_New_Groups()
    {
        var (_, accessToken) = await SignupAndLoginAsync("lister@example.com", "Lister");
        AuthorizeClient(_client, accessToken);

        // After signup, Private Sammlung is auto-created. Create one more.
        var created = await _client.PostAsJsonAsync("/api/groups",
            new GroupEndpoints.CreateGroupRequest("Familie", null, null));
        created.EnsureSuccessStatusCode();

        var response = await _client.GetAsync("/api/groups");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var groups = await response.Content.ReadFromJsonAsync<GroupEndpoints.GroupSummaryDto[]>();
        Assert.NotNull(groups);
        Assert.Equal(2, groups!.Length);
        Assert.Contains(groups, g => g.IsPrivateCollection);
        Assert.Contains(groups, g => g.Name == "Familie");
    }

    [Fact]
    public async Task ListMyGroups_Only_Shows_Groups_User_Is_Member_Of()
    {
        var (_, aTok) = await SignupAndLoginAsync("alone-a@example.com", "A");
        var (_, bTok) = await SignupAndLoginAsync("alone-b@example.com", "B");

        // A creates a group.
        using var clientA = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientA, aTok);
        var create = await clientA.PostAsJsonAsync("/api/groups",
            new GroupEndpoints.CreateGroupRequest("A's Group", null, null));
        create.EnsureSuccessStatusCode();

        // B lists — should see only their own Private Sammlung.
        using var clientB = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientB, bTok);
        var listB = await clientB.GetAsync("/api/groups");
        var groupsB = (await listB.Content.ReadFromJsonAsync<GroupEndpoints.GroupSummaryDto[]>())!;
        Assert.Single(groupsB);
        Assert.True(groupsB[0].IsPrivateCollection);
    }

    // ── GET /api/groups/{id} (detail) ───────────────────────────────

    [Fact]
    public async Task GetGroupDetail_Returns_Members_For_Member()
    {
        var (_, accessToken) = await SignupAndLoginAsync("detail@example.com", "Detail");
        AuthorizeClient(_client, accessToken);

        var create = await _client.PostAsJsonAsync("/api/groups",
            new GroupEndpoints.CreateGroupRequest("Mein Kochbuch", null, null));
        var created = (await create.Content.ReadFromJsonAsync<GroupEndpoints.GroupSummaryDto>())!;

        var detail = await _client.GetAsync($"/api/groups/{created.Id}");
        Assert.Equal(HttpStatusCode.OK, detail.StatusCode);
        var body = (await detail.Content.ReadFromJsonAsync<GroupEndpoints.GroupDetailDto>())!;
        Assert.Equal(created.Id, body.Id);
        Assert.Single(body.Members);
        Assert.Equal("Admin", body.Members[0].Role);
    }

    [Fact]
    public async Task GetGroupDetail_Returns_403_For_Non_Member()
    {
        var (_, aTok) = await SignupAndLoginAsync("detail-a@example.com", "DA");
        var (_, bTok) = await SignupAndLoginAsync("detail-b@example.com", "DB");

        using var clientA = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientA, aTok);
        var create = await clientA.PostAsJsonAsync("/api/groups",
            new GroupEndpoints.CreateGroupRequest("A Group", null, null));
        var created = (await create.Content.ReadFromJsonAsync<GroupEndpoints.GroupSummaryDto>())!;

        using var clientB = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientB, bTok);
        var detail = await clientB.GetAsync($"/api/groups/{created.Id}");
        Assert.Equal(HttpStatusCode.Forbidden, detail.StatusCode);
    }

    // ── PUT /api/groups/{id} ────────────────────────────────────────

    [Fact]
    public async Task UpdateGroup_As_Admin_Returns_200_And_Persists()
    {
        var (_, accessToken) = await SignupAndLoginAsync("update@example.com", "Upd");
        AuthorizeClient(_client, accessToken);
        var create = await _client.PostAsJsonAsync("/api/groups",
            new GroupEndpoints.CreateGroupRequest("Alt", null, null));
        var created = (await create.Content.ReadFromJsonAsync<GroupEndpoints.GroupSummaryDto>())!;

        var update = await _client.PutAsJsonAsync(
            $"/api/groups/{created.Id}",
            new GroupEndpoints.UpdateGroupRequest("Neu", "Beschreibung", 3m, null));

        Assert.Equal(HttpStatusCode.OK, update.StatusCode);
        var body = (await update.Content.ReadFromJsonAsync<GroupEndpoints.GroupSummaryDto>())!;
        Assert.Equal("Neu", body.Name);
        Assert.Equal("Beschreibung", body.Description);
        Assert.Equal(3m, body.DefaultServings);
    }

    [Fact]
    public async Task UpdateGroup_As_Member_Returns_403()
    {
        var (_, aTok) = await SignupAndLoginAsync("upd-a@example.com", "UA");
        var (bId, bTok) = await SignupAndLoginAsync("upd-b@example.com", "UB");

        using var clientA = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientA, aTok);
        var create = await clientA.PostAsJsonAsync("/api/groups",
            new GroupEndpoints.CreateGroupRequest("Gemeinsam", null, null));
        var created = (await create.Content.ReadFromJsonAsync<GroupEndpoints.GroupSummaryDto>())!;

        await AddMembershipAsync(created.Id, bId, GroupRole.Member);

        using var clientB = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientB, bTok);
        var update = await clientB.PutAsJsonAsync(
            $"/api/groups/{created.Id}",
            new GroupEndpoints.UpdateGroupRequest("Neu", null, null, null));

        Assert.Equal(HttpStatusCode.Forbidden, update.StatusCode);
    }

    // ── DELETE /api/groups/{id} ─────────────────────────────────────

    [Fact]
    public async Task DeleteGroup_As_Admin_SoftDeletes()
    {
        var (_, accessToken) = await SignupAndLoginAsync("del@example.com", "Del");
        AuthorizeClient(_client, accessToken);
        var create = await _client.PostAsJsonAsync("/api/groups",
            new GroupEndpoints.CreateGroupRequest("ZuLöschen", null, null));
        var created = (await create.Content.ReadFromJsonAsync<GroupEndpoints.GroupSummaryDto>())!;

        var delete = await _client.DeleteAsync($"/api/groups/{created.Id}");
        Assert.Equal(HttpStatusCode.NoContent, delete.StatusCode);

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var reloaded = await db.Groups.SingleAsync(g => g.Id == created.Id);
        Assert.NotNull(reloaded.DeletedAt);
    }

    [Fact]
    public async Task DeleteGroup_PrivateSammlung_Returns_400_With_Protected_Code()
    {
        var (_, accessToken) = await SignupAndLoginAsync("private-del@example.com", "PD");
        AuthorizeClient(_client, accessToken);

        var list = await _client.GetAsync("/api/groups");
        var groups = (await list.Content.ReadFromJsonAsync<GroupEndpoints.GroupSummaryDto[]>())!;
        var privateSammlung = groups.Single(g => g.IsPrivateCollection);

        var delete = await _client.DeleteAsync($"/api/groups/{privateSammlung.Id}");
        Assert.Equal(HttpStatusCode.BadRequest, delete.StatusCode);
        var error = await delete.Content.ReadFromJsonAsync<GroupEndpoints.ErrorResponse>();
        Assert.Equal("private_collection_protected", error!.Code);
    }

    // ── Invite flow ─────────────────────────────────────────────────

    [Fact]
    public async Task InviteFlow_Full_Happy_Path()
    {
        var (aliceId, aTok) = await SignupAndLoginAsync("alice-inv@example.com", "Alice");
        var (bobId, bTok) = await SignupAndLoginAsync("bob-inv@example.com", "Bob");

        using var clientA = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientA, aTok);
        var create = await clientA.PostAsJsonAsync("/api/groups",
            new GroupEndpoints.CreateGroupRequest("Familie", null, null));
        var group = (await create.Content.ReadFromJsonAsync<GroupEndpoints.GroupSummaryDto>())!;

        // A invites B
        var invite = await clientA.PostAsJsonAsync($"/api/groups/{group.Id}/invites",
            new GroupEndpoints.InviteToGroupRequest(bobId));
        Assert.Equal(HttpStatusCode.Created, invite.StatusCode);
        var inviteBody = (await invite.Content.ReadFromJsonAsync<GroupEndpoints.GroupInviteDto>())!;
        Assert.Equal("Pending", inviteBody.Status);

        // B sees the pending invite
        using var clientB = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientB, bTok);
        var received = await clientB.GetAsync("/api/groups/invites");
        var list = (await received.Content.ReadFromJsonAsync<GroupEndpoints.ReceivedInviteDto[]>())!;
        Assert.Single(list);
        Assert.Equal("Familie", list[0].GroupName);
        Assert.Equal("Alice", list[0].InviterDisplayName);

        // B accepts
        var accept = await clientB.PostAsync($"/api/groups/invites/{list[0].Id}/accept", content: null);
        Assert.Equal(HttpStatusCode.OK, accept.StatusCode);

        // B is now a member
        var groupsAfter = await clientB.GetAsync("/api/groups");
        var mine = (await groupsAfter.Content.ReadFromJsonAsync<GroupEndpoints.GroupSummaryDto[]>())!;
        Assert.Contains(mine, g => g.Id == group.Id && g.MyRole == "Member");

        // A sees 2 members now
        var detail = await clientA.GetAsync($"/api/groups/{group.Id}");
        var detailBody = (await detail.Content.ReadFromJsonAsync<GroupEndpoints.GroupDetailDto>())!;
        Assert.Equal(2, detailBody.Members.Length);
        _ = aliceId; // silence unused (kept for scenario clarity)
    }

    [Fact]
    public async Task Invite_AlreadyMember_Returns_400()
    {
        var (aliceId, aTok) = await SignupAndLoginAsync("alice-m@example.com", "Alice");
        var (bobId, _) = await SignupAndLoginAsync("bob-m@example.com", "Bob");

        using var clientA = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientA, aTok);
        var create = await clientA.PostAsJsonAsync("/api/groups",
            new GroupEndpoints.CreateGroupRequest("Familie", null, null));
        var group = (await create.Content.ReadFromJsonAsync<GroupEndpoints.GroupSummaryDto>())!;
        await AddMembershipAsync(group.Id, bobId, GroupRole.Member);

        var invite = await clientA.PostAsJsonAsync($"/api/groups/{group.Id}/invites",
            new GroupEndpoints.InviteToGroupRequest(bobId));
        Assert.Equal(HttpStatusCode.BadRequest, invite.StatusCode);
        var body = await invite.Content.ReadFromJsonAsync<GroupEndpoints.ErrorResponse>();
        Assert.Equal("already_member", body!.Code);
        _ = aliceId;
    }

    [Fact]
    public async Task Invite_AlreadyPending_Returns_400()
    {
        var (_, aTok) = await SignupAndLoginAsync("alice-p@example.com", "Alice");
        var (bobId, _) = await SignupAndLoginAsync("bob-p@example.com", "Bob");

        using var clientA = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientA, aTok);
        var create = await clientA.PostAsJsonAsync("/api/groups",
            new GroupEndpoints.CreateGroupRequest("Familie", null, null));
        var group = (await create.Content.ReadFromJsonAsync<GroupEndpoints.GroupSummaryDto>())!;

        var first = await clientA.PostAsJsonAsync($"/api/groups/{group.Id}/invites",
            new GroupEndpoints.InviteToGroupRequest(bobId));
        first.EnsureSuccessStatusCode();

        var second = await clientA.PostAsJsonAsync($"/api/groups/{group.Id}/invites",
            new GroupEndpoints.InviteToGroupRequest(bobId));
        Assert.Equal(HttpStatusCode.BadRequest, second.StatusCode);
        var body = await second.Content.ReadFromJsonAsync<GroupEndpoints.ErrorResponse>();
        Assert.Equal("invite_pending", body!.Code);
    }

    [Fact]
    public async Task Invite_NonMember_Inviter_Returns_403()
    {
        var (_, aTok) = await SignupAndLoginAsync("alice-nm@example.com", "Alice");
        var (bobId, bTok) = await SignupAndLoginAsync("bob-nm@example.com", "Bob");
        var (charlieId, _) = await SignupAndLoginAsync("charlie-nm@example.com", "Charlie");

        using var clientA = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientA, aTok);
        var create = await clientA.PostAsJsonAsync("/api/groups",
            new GroupEndpoints.CreateGroupRequest("Familie", null, null));
        var group = (await create.Content.ReadFromJsonAsync<GroupEndpoints.GroupSummaryDto>())!;

        // Bob is NOT a member of A's group — should get 403.
        using var clientB = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientB, bTok);
        var invite = await clientB.PostAsJsonAsync($"/api/groups/{group.Id}/invites",
            new GroupEndpoints.InviteToGroupRequest(charlieId));
        Assert.Equal(HttpStatusCode.Forbidden, invite.StatusCode);
        _ = bobId;
    }

    [Fact]
    public async Task Decline_Invite_Does_Not_Add_Membership()
    {
        var (_, aTok) = await SignupAndLoginAsync("alice-d@example.com", "Alice");
        var (bobId, bTok) = await SignupAndLoginAsync("bob-d@example.com", "Bob");

        using var clientA = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientA, aTok);
        var create = await clientA.PostAsJsonAsync("/api/groups",
            new GroupEndpoints.CreateGroupRequest("Familie", null, null));
        var group = (await create.Content.ReadFromJsonAsync<GroupEndpoints.GroupSummaryDto>())!;

        var invite = await clientA.PostAsJsonAsync($"/api/groups/{group.Id}/invites",
            new GroupEndpoints.InviteToGroupRequest(bobId));
        var inviteBody = (await invite.Content.ReadFromJsonAsync<GroupEndpoints.GroupInviteDto>())!;

        using var clientB = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientB, bTok);
        var decline = await clientB.PostAsync($"/api/groups/invites/{inviteBody.Id}/decline", content: null);
        Assert.Equal(HttpStatusCode.OK, decline.StatusCode);

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var membership = await db.GroupMemberships
            .FirstOrDefaultAsync(m => m.GroupId == group.Id && m.UserId == bobId);
        Assert.Null(membership);
    }

    [Fact]
    public async Task Accept_Invite_As_Non_Target_User_Returns_403()
    {
        var (_, aTok) = await SignupAndLoginAsync("alice-x@example.com", "Alice");
        var (bobId, _) = await SignupAndLoginAsync("bob-x@example.com", "Bob");
        var (_, charlieTok) = await SignupAndLoginAsync("charlie-x@example.com", "Charlie");

        using var clientA = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientA, aTok);
        var create = await clientA.PostAsJsonAsync("/api/groups",
            new GroupEndpoints.CreateGroupRequest("Familie", null, null));
        var group = (await create.Content.ReadFromJsonAsync<GroupEndpoints.GroupSummaryDto>())!;

        var invite = await clientA.PostAsJsonAsync($"/api/groups/{group.Id}/invites",
            new GroupEndpoints.InviteToGroupRequest(bobId));
        var inviteBody = (await invite.Content.ReadFromJsonAsync<GroupEndpoints.GroupInviteDto>())!;

        using var clientC = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientC, charlieTok);
        var accept = await clientC.PostAsync($"/api/groups/invites/{inviteBody.Id}/accept", content: null);
        Assert.Equal(HttpStatusCode.Forbidden, accept.StatusCode);
    }

    // ── Member management ───────────────────────────────────────────

    [Fact]
    public async Task ChangeMemberRole_LastAdmin_Demotion_Returns_400_LastAdmin()
    {
        var (aliceId, aTok) = await SignupAndLoginAsync("last-a@example.com", "Alice");
        AuthorizeClient(_client, aTok);

        var create = await _client.PostAsJsonAsync("/api/groups",
            new GroupEndpoints.CreateGroupRequest("Allein", null, null));
        var group = (await create.Content.ReadFromJsonAsync<GroupEndpoints.GroupSummaryDto>())!;

        var res = await _client.PutAsJsonAsync(
            $"/api/groups/{group.Id}/members/{aliceId}",
            new GroupEndpoints.ChangeMemberRoleRequest("Member"));

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        var body = await res.Content.ReadFromJsonAsync<GroupEndpoints.ErrorResponse>();
        Assert.Equal("last_admin", body!.Code);
    }

    [Fact]
    public async Task ChangeMemberRole_Promote_To_Admin_Works()
    {
        var (_, aTok) = await SignupAndLoginAsync("promo-a@example.com", "A");
        var (bobId, _) = await SignupAndLoginAsync("promo-b@example.com", "B");

        using var clientA = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientA, aTok);
        var create = await clientA.PostAsJsonAsync("/api/groups",
            new GroupEndpoints.CreateGroupRequest("Familie", null, null));
        var group = (await create.Content.ReadFromJsonAsync<GroupEndpoints.GroupSummaryDto>())!;
        await AddMembershipAsync(group.Id, bobId, GroupRole.Member);

        var res = await clientA.PutAsJsonAsync(
            $"/api/groups/{group.Id}/members/{bobId}",
            new GroupEndpoints.ChangeMemberRoleRequest("Admin"));

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var m = await db.GroupMemberships.SingleAsync(x => x.GroupId == group.Id && x.UserId == bobId);
        Assert.Equal(GroupRole.Admin, m.Role);
    }

    [Fact]
    public async Task LeaveGroup_Works_When_Not_Last_Admin()
    {
        var (_, aTok) = await SignupAndLoginAsync("leave-a@example.com", "A");
        var (bobId, bTok) = await SignupAndLoginAsync("leave-b@example.com", "B");

        using var clientA = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientA, aTok);
        var create = await clientA.PostAsJsonAsync("/api/groups",
            new GroupEndpoints.CreateGroupRequest("Familie", null, null));
        var group = (await create.Content.ReadFromJsonAsync<GroupEndpoints.GroupSummaryDto>())!;
        await AddMembershipAsync(group.Id, bobId, GroupRole.Member);

        using var clientB = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientB, bTok);
        var leave = await clientB.DeleteAsync($"/api/groups/{group.Id}/members/{bobId}");
        Assert.Equal(HttpStatusCode.NoContent, leave.StatusCode);

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var m = await db.GroupMemberships.FirstOrDefaultAsync(x => x.GroupId == group.Id && x.UserId == bobId);
        Assert.Null(m);
    }

    [Fact]
    public async Task Leave_As_Last_Admin_Returns_400()
    {
        var (aliceId, accessToken) = await SignupAndLoginAsync("only-admin@example.com", "OA");
        AuthorizeClient(_client, accessToken);

        var create = await _client.PostAsJsonAsync("/api/groups",
            new GroupEndpoints.CreateGroupRequest("Solo", null, null));
        var group = (await create.Content.ReadFromJsonAsync<GroupEndpoints.GroupSummaryDto>())!;

        var leave = await _client.DeleteAsync($"/api/groups/{group.Id}/members/{aliceId}");
        Assert.Equal(HttpStatusCode.BadRequest, leave.StatusCode);
        var body = await leave.Content.ReadFromJsonAsync<GroupEndpoints.ErrorResponse>();
        Assert.Equal("last_admin", body!.Code);
    }

    [Fact]
    public async Task RemoveMember_From_PrivateSammlung_Returns_400()
    {
        var (aliceId, accessToken) = await SignupAndLoginAsync("rm-private@example.com", "P");
        AuthorizeClient(_client, accessToken);

        var list = await _client.GetAsync("/api/groups");
        var groups = (await list.Content.ReadFromJsonAsync<GroupEndpoints.GroupSummaryDto[]>())!;
        var priv = groups.Single(g => g.IsPrivateCollection);

        var res = await _client.DeleteAsync($"/api/groups/{priv.Id}/members/{aliceId}");
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    // ── User search ─────────────────────────────────────────────────

    [Fact]
    public async Task UserSearch_Matches_By_DisplayName_Substring()
    {
        var (_, aTok) = await SignupAndLoginAsync("searcher@example.com", "Searcher");
        await SignupAndLoginAsync("thomas@example.com", "Thomas Müller");
        await SignupAndLoginAsync("tomke@example.com", "Tomke Berger");
        await SignupAndLoginAsync("bruno@example.com", "Bruno Bauer");

        AuthorizeClient(_client, aTok);
        var response = await _client.GetAsync("/api/users/search?q=tom");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var results = (await response.Content.ReadFromJsonAsync<GroupEndpoints.UserSearchResultDto[]>())!;
        Assert.Equal(2, results.Length);
        Assert.All(results, r => Assert.Contains("tom", r.DisplayName, StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task UserSearch_Excludes_Current_User()
    {
        var (_, aTok) = await SignupAndLoginAsync("myself@example.com", "Myself Unique");
        AuthorizeClient(_client, aTok);
        var response = await _client.GetAsync("/api/users/search?q=Myself");
        var results = (await response.Content.ReadFromJsonAsync<GroupEndpoints.UserSearchResultDto[]>())!;
        Assert.Empty(results);
    }

    [Fact]
    public async Task UserSearch_Excludes_Group_Members_When_ExcludeGroupId_Set()
    {
        var (_, aTok) = await SignupAndLoginAsync("sx-a@example.com", "Alice");
        var (bobId, _) = await SignupAndLoginAsync("sx-b@example.com", "Bob Excluded");
        await SignupAndLoginAsync("sx-c@example.com", "Bob Included");

        using var clientA = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientA, aTok);
        var create = await clientA.PostAsJsonAsync("/api/groups",
            new GroupEndpoints.CreateGroupRequest("Familie", null, null));
        var group = (await create.Content.ReadFromJsonAsync<GroupEndpoints.GroupSummaryDto>())!;
        await AddMembershipAsync(group.Id, bobId, GroupRole.Member);

        var response = await clientA.GetAsync($"/api/users/search?q=Bob&excludeGroupId={group.Id}");
        var results = (await response.Content.ReadFromJsonAsync<GroupEndpoints.UserSearchResultDto[]>())!;
        Assert.Single(results);
        Assert.Equal("Bob Included", results[0].DisplayName);
    }

    [Fact]
    public async Task UserSearch_Empty_Query_Returns_Empty()
    {
        var (_, accessToken) = await SignupAndLoginAsync("empty@example.com", "Empty");
        AuthorizeClient(_client, accessToken);

        var response = await _client.GetAsync("/api/users/search?q=");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var results = (await response.Content.ReadFromJsonAsync<GroupEndpoints.UserSearchResultDto[]>())!;
        Assert.Empty(results);
    }

    [Fact]
    public async Task UserSearch_Respects_Limit_Cap()
    {
        var (_, accessToken) = await SignupAndLoginAsync("limiter@example.com", "Limiter");
        AuthorizeClient(_client, accessToken);

        // Seed a bunch of searchable users.
        for (int i = 0; i < 25; i++)
            await SignupAndLoginAsync($"seed-{i}@example.com", $"Ziel User {i}");

        var response = await _client.GetAsync("/api/users/search?q=Ziel&limit=100");
        var results = (await response.Content.ReadFromJsonAsync<GroupEndpoints.UserSearchResultDto[]>())!;
        Assert.True(results.Length <= 20, "limit must cap at 20");
    }

    // ── Signup flow auto-creates Private Sammlung ───────────────────

    [Fact]
    public async Task Signup_AutoCreates_Private_Sammlung_For_New_User()
    {
        var (userId, accessToken) = await SignupAndLoginAsync("fresh@example.com", "Fresh User");
        AuthorizeClient(_client, accessToken);

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var count = await db.GroupMemberships
            .Where(m => m.UserId == userId)
            .Join(db.Groups, m => m.GroupId, g => g.Id, (m, g) => g)
            .CountAsync(g => g.IsPrivateCollection);
        Assert.Equal(1, count);
    }

    // ── internal helper ─────────────────────────────────────────────

    private async Task AddMembershipAsync(Guid groupId, Guid userId, GroupRole role)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var existing = await db.GroupMemberships
            .FirstOrDefaultAsync(m => m.GroupId == groupId && m.UserId == userId);
        if (existing is not null) return;
        var m = new GroupMembership(userId, groupId, role, DateTimeOffset.UtcNow);
        db.GroupMemberships.Add(m);
        await db.SaveChangesAsync();
    }
}
