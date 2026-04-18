using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using FamilienKochbuch.Api.Endpoints;
using FamilienKochbuch.Api.Tests.Infrastructure;
using FamilienKochbuch.Domain.Enums;
using FamilienKochbuch.Infrastructure.Persistence;
using FamilienKochbuch.Infrastructure.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace FamilienKochbuch.Api.Tests.Endpoints;

/// <summary>
/// End-to-end tests for the S4 custom-tag create/delete endpoints layered
/// onto <c>/api/groups/{groupId}/tags</c>. Every member can create a custom
/// tag; only admins can delete a custom tag; global tags are protected.
/// </summary>
public class CustomTagEndpointsTests : IClassFixture<FamilienKochbuchWebApplicationFactory>, IAsyncLifetime
{
    private readonly FamilienKochbuchWebApplicationFactory _factory;
    private HttpClient _client = null!;

    public CustomTagEndpointsTests(FamilienKochbuchWebApplicationFactory factory)
    {
        _factory = factory;
    }

    public async Task InitializeAsync()
    {
        _client = _factory.CreateRateLimitBypassingClient(
            new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { HandleCookies = true });
        _factory.Email.Clear();
        _factory.Photos.Clear();
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
        db.Ratings.RemoveRange(db.Ratings);
        db.RecipeTags.RemoveRange(db.RecipeTags);
        db.Ingredients.RemoveRange(db.Ingredients);
        db.RecipeSteps.RemoveRange(db.RecipeSteps);
        db.Recipes.RemoveRange(db.Recipes);
        db.Tags.RemoveRange(db.Tags.Where(t => t.GroupId != null));
        db.GroupInvites.RemoveRange(db.GroupInvites);
        db.GroupMemberships.RemoveRange(db.GroupMemberships);
        db.Groups.RemoveRange(db.Groups);
        db.RefreshTokens.RemoveRange(db.RefreshTokens);
        db.AppInvites.RemoveRange(db.AppInvites);
        var nonAdmin = db.Users.Where(u => u.Email != "admin@test.local");
        db.Users.RemoveRange(nonAdmin);
        await db.SaveChangesAsync();

        var adminId = await db.Users.Where(u => u.Email == "admin@test.local").Select(u => u.Id).SingleAsync();
        var privateCollections = scope.ServiceProvider.GetRequiredService<IPrivateCollectionService>();
        await privateCollections.EnsurePrivateCollectionAsync(adminId);

        if (!await db.Tags.AnyAsync(t => t.GroupId == null))
        {
            db.Tags.Add(Domain.Entities.Tag.CreateGlobal("Mittag", TagCategory.Mahlzeit));
            db.Tags.Add(Domain.Entities.Tag.CreateGlobal("schnell", TagCategory.Aufwand));
            await db.SaveChangesAsync();
        }
    }

    private async Task<(Guid UserId, string AccessToken)> SignupAndLoginAsync(string email, string displayName)
    {
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

    private async Task<Guid> CreateGroupAsync(HttpClient client, string name = "Kochbuch")
    {
        var create = await client.PostAsJsonAsync("/api/groups",
            new GroupEndpoints.CreateGroupRequest(name, null, null));
        create.EnsureSuccessStatusCode();
        var body = (await create.Content.ReadFromJsonAsync<GroupEndpoints.GroupSummaryDto>())!;
        return body.Id;
    }

    // ── POST /api/groups/{groupId}/tags ─────────────────────────────────

    [Fact]
    public async Task CreateTag_Happy_Path_Returns_201_And_New_Tag()
    {
        var (_, token) = await SignupAndLoginAsync("ct1@ex.com", "C");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);

        var response = await _client.PostAsJsonAsync($"/api/groups/{groupId}/tags",
            new RecipeEndpoints.CreateTagRequest("Kinderfreundlich", "Custom"));

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var body = (await response.Content.ReadFromJsonAsync<RecipeEndpoints.TagDto>())!;
        Assert.Equal("Kinderfreundlich", body.Name);
        Assert.Equal("Custom", body.Category);
        Assert.False(body.IsGlobal);
        Assert.Equal(groupId, body.GroupId);
    }

    [Fact]
    public async Task CreateTag_Returns_400_On_Duplicate()
    {
        var (_, token) = await SignupAndLoginAsync("ct2@ex.com", "C");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);

        var first = await _client.PostAsJsonAsync($"/api/groups/{groupId}/tags",
            new RecipeEndpoints.CreateTagRequest("Kinderfreundlich", "Custom"));
        first.EnsureSuccessStatusCode();

        var second = await _client.PostAsJsonAsync($"/api/groups/{groupId}/tags",
            new RecipeEndpoints.CreateTagRequest("Kinderfreundlich", "Custom"));
        Assert.Equal(HttpStatusCode.BadRequest, second.StatusCode);
        var err = (await second.Content.ReadFromJsonAsync<RecipeEndpoints.ErrorResponse>())!;
        Assert.Equal("tag_exists", err.Code);
    }

    [Fact]
    public async Task CreateTag_403_For_Non_Member()
    {
        var (_, aTok) = await SignupAndLoginAsync("cta@ex.com", "A");
        var (_, bTok) = await SignupAndLoginAsync("ctb@ex.com", "B");
        using var clientA = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientA, aTok);
        var groupId = await CreateGroupAsync(clientA);

        using var clientB = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientB, bTok);
        var response = await clientB.PostAsJsonAsync($"/api/groups/{groupId}/tags",
            new RecipeEndpoints.CreateTagRequest("Hacker", "Custom"));
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task CreateTag_400_On_Blank_Name()
    {
        var (_, token) = await SignupAndLoginAsync("ctn@ex.com", "C");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);

        var response = await _client.PostAsJsonAsync($"/api/groups/{groupId}/tags",
            new RecipeEndpoints.CreateTagRequest("   ", "Custom"));
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task CreateTag_400_On_Invalid_Category()
    {
        var (_, token) = await SignupAndLoginAsync("ctc@ex.com", "C");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);

        var response = await _client.PostAsJsonAsync($"/api/groups/{groupId}/tags",
            new RecipeEndpoints.CreateTagRequest("Name", "NotARealCategory"));
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task CreateTag_Appears_In_GroupTags_Listing()
    {
        var (_, token) = await SignupAndLoginAsync("ctl@ex.com", "L");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);

        var created = await _client.PostAsJsonAsync($"/api/groups/{groupId}/tags",
            new RecipeEndpoints.CreateTagRequest("Omas Rezepte", "Custom"));
        created.EnsureSuccessStatusCode();

        var list = await _client.GetFromJsonAsync<RecipeEndpoints.TagDto[]>(
            $"/api/groups/{groupId}/tags");
        Assert.Contains(list!, t => t.Name == "Omas Rezepte" && t.GroupId == groupId);
    }

    // ── DELETE /api/groups/{groupId}/tags/{tagId} ───────────────────────

    [Fact]
    public async Task DeleteTag_Admin_Removes_Custom_Tag()
    {
        var (_, token) = await SignupAndLoginAsync("ctd@ex.com", "A");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);

        var createRes = await _client.PostAsJsonAsync($"/api/groups/{groupId}/tags",
            new RecipeEndpoints.CreateTagRequest("Weg damit", "Custom"));
        var created = (await createRes.Content.ReadFromJsonAsync<RecipeEndpoints.TagDto>())!;

        var del = await _client.DeleteAsync($"/api/groups/{groupId}/tags/{created.Id}");
        Assert.Equal(HttpStatusCode.NoContent, del.StatusCode);

        var list = await _client.GetFromJsonAsync<RecipeEndpoints.TagDto[]>($"/api/groups/{groupId}/tags");
        Assert.DoesNotContain(list!, t => t.Id == created.Id);
    }

    [Fact]
    public async Task DeleteTag_Non_Admin_Member_Forbidden()
    {
        var (adminUserId, adminTok) = await SignupAndLoginAsync("cda@ex.com", "Admin");
        var (memberUserId, memberTok) = await SignupAndLoginAsync("cdm@ex.com", "Member");
        using var adminClient = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(adminClient, adminTok);
        using var memberClient = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(memberClient, memberTok);

        var groupId = await CreateGroupAsync(adminClient, "Team");
        var inviteRes = await adminClient.PostAsJsonAsync($"/api/groups/{groupId}/invites",
            new GroupEndpoints.InviteToGroupRequest(memberUserId));
        inviteRes.EnsureSuccessStatusCode();
        var invite = (await inviteRes.Content.ReadFromJsonAsync<GroupEndpoints.GroupInviteDto>())!;
        var accept = await memberClient.PostAsync($"/api/groups/invites/{invite.Id}/accept", null);
        accept.EnsureSuccessStatusCode();

        var createRes = await adminClient.PostAsJsonAsync($"/api/groups/{groupId}/tags",
            new RecipeEndpoints.CreateTagRequest("Testtag", "Custom"));
        var tag = (await createRes.Content.ReadFromJsonAsync<RecipeEndpoints.TagDto>())!;

        var del = await memberClient.DeleteAsync($"/api/groups/{groupId}/tags/{tag.Id}");
        Assert.Equal(HttpStatusCode.Forbidden, del.StatusCode);
        _ = adminUserId;
    }

    [Fact]
    public async Task DeleteTag_Non_Member_Forbidden()
    {
        var (_, aTok) = await SignupAndLoginAsync("cdna@ex.com", "A");
        var (_, bTok) = await SignupAndLoginAsync("cdnb@ex.com", "B");
        using var clientA = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientA, aTok);
        var groupId = await CreateGroupAsync(clientA);
        var createRes = await clientA.PostAsJsonAsync($"/api/groups/{groupId}/tags",
            new RecipeEndpoints.CreateTagRequest("Probe", "Custom"));
        var tag = (await createRes.Content.ReadFromJsonAsync<RecipeEndpoints.TagDto>())!;

        using var clientB = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientB, bTok);
        var del = await clientB.DeleteAsync($"/api/groups/{groupId}/tags/{tag.Id}");
        Assert.Equal(HttpStatusCode.Forbidden, del.StatusCode);
    }

    [Fact]
    public async Task DeleteTag_400_When_Deleting_Global_Tag()
    {
        var (_, token) = await SignupAndLoginAsync("cdg@ex.com", "A");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);

        // Grab a global tag id.
        Guid globalTagId;
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            globalTagId = await db.Tags.Where(t => t.GroupId == null).Select(t => t.Id).FirstAsync();
        }

        var del = await _client.DeleteAsync($"/api/groups/{groupId}/tags/{globalTagId}");
        Assert.Equal(HttpStatusCode.BadRequest, del.StatusCode);
        var err = (await del.Content.ReadFromJsonAsync<RecipeEndpoints.ErrorResponse>())!;
        Assert.Equal("global_tag_protected", err.Code);
    }

    [Fact]
    public async Task DeleteTag_404_When_Tag_Not_In_Group()
    {
        var (_, token) = await SignupAndLoginAsync("cdnf@ex.com", "A");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);

        var del = await _client.DeleteAsync($"/api/groups/{groupId}/tags/{Guid.NewGuid()}");
        Assert.Equal(HttpStatusCode.NotFound, del.StatusCode);
    }
}
