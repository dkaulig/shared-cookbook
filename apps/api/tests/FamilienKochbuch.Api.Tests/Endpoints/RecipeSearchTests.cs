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
/// SEARCH-0 — end-to-end tests for the top-level cross-group recipe
/// search endpoint (<c>GET /api/recipes/search</c>). Authz scopes
/// results to groups the caller is a member of; result ranking uses
/// title (3) + tag (2) + description (1) weights when
/// <c>sort=relevance_desc</c>. Contract mirrors PAGE-0 pagination
/// plus an echoed <c>query</c> field.
/// </summary>
public class RecipeSearchTests : IClassFixture<FamilienKochbuchWebApplicationFactory>, IAsyncLifetime
{
    private readonly FamilienKochbuchWebApplicationFactory _factory;
    private HttpClient _client = null!;

    public RecipeSearchTests(FamilienKochbuchWebApplicationFactory factory)
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
    }

    // ── helpers ─────────────────────────────────────────────────────────

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

    private async Task<(Guid GroupId, string Name)> CreateGroupAsync(HttpClient client, string name)
    {
        var create = await client.PostAsJsonAsync("/api/groups",
            new GroupEndpoints.CreateGroupRequest(name, null, null));
        create.EnsureSuccessStatusCode();
        var body = (await create.Content.ReadFromJsonAsync<GroupEndpoints.GroupSummaryDto>())!;
        return (body.Id, name);
    }

    /// <summary>
    /// Seed a recipe directly via DbContext at the given <c>updatedAt</c>.
    /// Bypassing the HTTP path keeps the shared test clock still so the
    /// JWT ClockSkew doesn't drift across tests that seed a lot of rows.
    /// </summary>
    private async Task<Guid> SeedRecipeAsync(
        Guid groupId,
        Guid createdByUserId,
        string title,
        string? description = null,
        Guid[]? tagIds = null,
        DateTimeOffset? updatedAt = null)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var now = updatedAt ?? DateTimeOffset.Parse("2026-03-01T00:00:00Z");
        var recipe = new FamilienKochbuch.Domain.Entities.Recipe(
            groupId, createdByUserId, title, description, 4, null, 1, null,
            FamilienKochbuch.Domain.Enums.RecipeSourceType.Manual, null, now);
        db.Recipes.Add(recipe);
        if (tagIds is not null)
        {
            foreach (var tagId in tagIds)
            {
                db.RecipeTags.Add(new FamilienKochbuch.Domain.Entities.RecipeTag(recipe.Id, tagId));
            }
        }
        await db.SaveChangesAsync();
        return recipe.Id;
    }

    /// <summary>
    /// Create a group-scoped custom tag with <paramref name="name"/>
    /// directly via DbContext. Returns the tag id.
    /// </summary>
    private async Task<Guid> SeedGroupTagAsync(Guid groupId, Guid createdBy, string name)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var tag = FamilienKochbuch.Domain.Entities.Tag.CreateGroupScoped(createdBy, groupId, name);
        db.Tags.Add(tag);
        await db.SaveChangesAsync();
        return tag.Id;
    }

    private static async Task<RecipeEndpoints.RecipeGlobalSearchListDto> GetSearchAsync(
        HttpClient client, string query)
    {
        var response = await client.GetAsync($"/api/recipes/search?{query}");
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeGlobalSearchListDto>())!;
    }

    // ── Defaults + echo ─────────────────────────────────────────────────

    [Fact]
    public async Task Search_Defaults_Return_Page1_PageSize24_RelevanceDesc_WithEchoedQuery()
    {
        var (userId, token) = await SignupAndLoginAsync("dflt@ex.com", "D");
        AuthorizeClient(_client, token);
        var group = await CreateGroupAsync(_client, "G1");

        await SeedRecipeAsync(group.GroupId, userId, "Lasagne Classica");
        await SeedRecipeAsync(group.GroupId, userId, "Pizza");

        var body = await GetSearchAsync(_client, "q=lasagne");

        Assert.Equal(1, body.Page);
        Assert.Equal(24, body.PageSize);
        Assert.Equal("lasagne", body.Query);
        Assert.Single(body.Items);
        Assert.Equal("Lasagne Classica", body.Items[0].Title);
        Assert.False(body.HasNextPage);
        Assert.False(body.HasPrevPage);
    }

    // ── Empty q — 400 invalid_query ─────────────────────────────────────

    [Theory]
    [InlineData("q=")]
    [InlineData("q=%20")] // trimmed → empty
    [InlineData("")]      // missing q entirely
    public async Task Search_EmptyQ_Returns_400_InvalidQuery(string query)
    {
        var (_, token) = await SignupAndLoginAsync($"eq-{query.GetHashCode():x}@ex.com", "EQ");
        AuthorizeClient(_client, token);

        var response = await _client.GetAsync($"/api/recipes/search?{query}");
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<FamilienKochbuch.Api.Services.ErrorResponse>();
        Assert.Equal("invalid_query", body!.Code);
    }

    [Fact]
    public async Task Search_QueryTooLong_Returns_400_InvalidQuery()
    {
        var (_, token) = await SignupAndLoginAsync("qlong@ex.com", "QL");
        AuthorizeClient(_client, token);

        var tooLong = new string('a', 201);
        var response = await _client.GetAsync($"/api/recipes/search?q={tooLong}");
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<FamilienKochbuch.Api.Services.ErrorResponse>();
        Assert.Equal("invalid_query", body!.Code);
    }

    // ── Invalid sort ────────────────────────────────────────────────────

    [Theory]
    [InlineData("bogus")]
    [InlineData("UPDATED_DESC")]
    [InlineData("cook_count_desc")] // Still cut per design doc.
    public async Task Search_InvalidSort_Returns_400_InvalidSort(string sort)
    {
        var (_, token) = await SignupAndLoginAsync($"is-{sort}@ex.com", "IS");
        AuthorizeClient(_client, token);

        var response = await _client.GetAsync($"/api/recipes/search?q=x&sort={sort}");
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<FamilienKochbuch.Api.Services.ErrorResponse>();
        Assert.Equal("invalid_sort", body!.Code);
    }

    // ── Invalid page / pageSize ─────────────────────────────────────────

    [Theory]
    [InlineData("page=0")]
    [InlineData("page=-1")]
    public async Task Search_InvalidPage_Returns_400_InvalidPage(string pageQuery)
    {
        var (_, token) = await SignupAndLoginAsync($"ip-{pageQuery.GetHashCode():x}@ex.com", "IP");
        AuthorizeClient(_client, token);

        var response = await _client.GetAsync($"/api/recipes/search?q=x&{pageQuery}");
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<FamilienKochbuch.Api.Services.ErrorResponse>();
        Assert.Equal("invalid_page", body!.Code);
    }

    [Theory]
    [InlineData("pageSize=0")]
    [InlineData("pageSize=101")]
    [InlineData("pageSize=-5")]
    public async Task Search_InvalidPageSize_Returns_400_InvalidPageSize(string q)
    {
        var (_, token) = await SignupAndLoginAsync($"ips-{q.GetHashCode():x}@ex.com", "IPS");
        AuthorizeClient(_client, token);

        var response = await _client.GetAsync($"/api/recipes/search?q=x&{q}");
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<FamilienKochbuch.Api.Services.ErrorResponse>();
        Assert.Equal("invalid_page_size", body!.Code);
    }

    // ── Authz hard-gate: 3 groups, caller in 2 ──────────────────────────

    [Fact]
    public async Task Search_Authz_DoesNotLeak_Recipes_From_Groups_Caller_Is_Not_In()
    {
        // Owner A creates groups A, B, and also group C (but never invites
        // the caller to C). Caller will sign up as a member of A and B.
        var (ownerId, ownerToken) = await SignupAndLoginAsync("owner-authz@ex.com", "O");
        using var ownerClient = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(ownerClient, ownerToken);
        var gA = await CreateGroupAsync(ownerClient, "A");
        var gB = await CreateGroupAsync(ownerClient, "B");
        var gC = await CreateGroupAsync(ownerClient, "C");

        var (callerId, callerToken) = await SignupAndLoginAsync("caller-authz@ex.com", "C");
        // Add caller to A and B directly via DB, not to C.
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var now = DateTimeOffset.UtcNow;
            db.GroupMemberships.Add(new FamilienKochbuch.Domain.Entities.GroupMembership(
                callerId, gA.GroupId, FamilienKochbuch.Domain.Enums.GroupRole.Member, now));
            db.GroupMemberships.Add(new FamilienKochbuch.Domain.Entities.GroupMembership(
                callerId, gB.GroupId, FamilienKochbuch.Domain.Enums.GroupRole.Member, now));
            await db.SaveChangesAsync();
        }

        // Seed the recipe only in group C — the one the caller is NOT in.
        await SeedRecipeAsync(gC.GroupId, ownerId, "Gochujang Forbidden");

        AuthorizeClient(_client, callerToken);
        var body = await GetSearchAsync(_client, "q=gochujang");

        Assert.Empty(body.Items);
        Assert.Equal(0, body.Total);
    }

    // ── Cross-group results ─────────────────────────────────────────────

    [Fact]
    public async Task Search_ReturnsResults_FromMultipleGroups_WithCorrect_GroupId_And_GroupName()
    {
        var (userId, token) = await SignupAndLoginAsync("cross@ex.com", "X");
        AuthorizeClient(_client, token);
        var gA = await CreateGroupAsync(_client, "Familie");
        var gB = await CreateGroupAsync(_client, "Partner");

        var idA = await SeedRecipeAsync(gA.GroupId, userId, "Gochujang Chicken");
        var idB = await SeedRecipeAsync(gB.GroupId, userId, "Gochujang Tofu");

        var body = await GetSearchAsync(_client, "q=gochujang");

        Assert.Equal(2, body.Total);
        Assert.Equal(2, body.Items.Length);

        var byId = body.Items.ToDictionary(i => i.Id);
        Assert.Equal(gA.GroupId, byId[idA].GroupId);
        Assert.Equal("Familie", byId[idA].GroupName);
        Assert.Equal(gB.GroupId, byId[idB].GroupId);
        Assert.Equal("Partner", byId[idB].GroupName);
    }

    // ── Relevance ranking ───────────────────────────────────────────────

    [Fact]
    public async Task Search_RelevanceDesc_Orders_Title_Above_Tag_Above_Description()
    {
        var (userId, token) = await SignupAndLoginAsync("rel@ex.com", "R");
        AuthorizeClient(_client, token);
        var group = await CreateGroupAsync(_client, "G");

        var matcherTag = await SeedGroupTagAsync(group.GroupId, userId, "kimchi");

        // "kimchi" appears only in description → weight 1.
        var descId = await SeedRecipeAsync(group.GroupId, userId,
            title: "Banchan", description: "mit kimchi drin");
        // "kimchi" appears only as tag → weight 2.
        var tagId = await SeedRecipeAsync(group.GroupId, userId,
            title: "Bibimbap", tagIds: new[] { matcherTag });
        // "kimchi" appears in title → weight 3 (can also match tag if tagged).
        var titleId = await SeedRecipeAsync(group.GroupId, userId,
            title: "Kimchi Jjigae");

        var body = await GetSearchAsync(_client, "q=kimchi&sort=relevance_desc");

        Assert.Equal(3, body.Total);
        Assert.Equal(new[] { titleId, tagId, descId },
            body.Items.Select(i => i.Id).ToArray());
    }

    // ── Non-relevance sort ignores score ────────────────────────────────

    [Fact]
    public async Task Search_SortUpdatedDesc_Ignores_Relevance_Score()
    {
        var (userId, token) = await SignupAndLoginAsync("upd@ex.com", "U");
        AuthorizeClient(_client, token);
        var group = await CreateGroupAsync(_client, "G");

        // Order by UpdatedAt DESC should give: newest first regardless of
        // how strong the title/tag match is.
        var oldId = await SeedRecipeAsync(group.GroupId, userId,
            title: "Kimchi Perfect Title",
            updatedAt: DateTimeOffset.Parse("2026-01-01T00:00:00Z"));
        var newId = await SeedRecipeAsync(group.GroupId, userId,
            title: "Soup", description: "mit kimchi",
            updatedAt: DateTimeOffset.Parse("2026-06-01T00:00:00Z"));

        var body = await GetSearchAsync(_client, "q=kimchi&sort=updated_desc");

        Assert.Equal(2, body.Total);
        Assert.Equal(new[] { newId, oldId }, body.Items.Select(i => i.Id).ToArray());
    }

    // ── Stable tie-breaker on Id ────────────────────────────────────────

    [Fact]
    public async Task Search_StableTieBreaker_By_IdAsc_When_Relevance_Equal()
    {
        var (userId, token) = await SignupAndLoginAsync("tie@ex.com", "T");
        AuthorizeClient(_client, token);
        var group = await CreateGroupAsync(_client, "G");

        // Two recipes with identical title matches → same score.
        var a = await SeedRecipeAsync(group.GroupId, userId, "xa");
        var b = await SeedRecipeAsync(group.GroupId, userId, "xb");

        var body = await GetSearchAsync(_client, "q=x&sort=relevance_desc");

        Assert.Equal(2, body.Total);
        var expected = new[] { a, b }.OrderBy(id => id).ToArray();
        Assert.Equal(expected, body.Items.Select(i => i.Id).ToArray());
    }

    // ── total accurate across groups ────────────────────────────────────

    [Fact]
    public async Task Search_Total_Accurate_Across_Multiple_Groups()
    {
        var (userId, token) = await SignupAndLoginAsync("total@ex.com", "T");
        AuthorizeClient(_client, token);
        var gA = await CreateGroupAsync(_client, "A");
        var gB = await CreateGroupAsync(_client, "B");

        for (var i = 0; i < 3; i++) await SeedRecipeAsync(gA.GroupId, userId, $"xmatch-a{i}");
        for (var i = 0; i < 2; i++) await SeedRecipeAsync(gB.GroupId, userId, $"xmatch-b{i}");
        // Non-matching rows should NOT be counted.
        await SeedRecipeAsync(gA.GroupId, userId, "Pizza");

        var body = await GetSearchAsync(_client, "q=xmatch");

        Assert.Equal(5, body.Total);
        Assert.Equal(5, body.Items.Length);
    }

    // ── Deep-link past end ──────────────────────────────────────────────

    [Fact]
    public async Task Search_DeepLink_Past_End_Returns_EmptyItems_With_HonestMeta()
    {
        var (userId, token) = await SignupAndLoginAsync("deep@ex.com", "D");
        AuthorizeClient(_client, token);
        var group = await CreateGroupAsync(_client, "G");

        for (var i = 0; i < 5; i++) await SeedRecipeAsync(group.GroupId, userId, $"xdeep-{i}");

        var body = await GetSearchAsync(_client, "q=xdeep&page=5&pageSize=10");

        Assert.Empty(body.Items);
        Assert.Equal(5, body.Total);
        Assert.False(body.HasNextPage);
        Assert.True(body.HasPrevPage);
    }

    // ── Soft-deleted excluded ───────────────────────────────────────────

    [Fact]
    public async Task Search_SoftDeleted_Recipes_Are_Excluded()
    {
        var (userId, token) = await SignupAndLoginAsync("soft@ex.com", "S");
        AuthorizeClient(_client, token);
        var group = await CreateGroupAsync(_client, "G");

        var keep = await SeedRecipeAsync(group.GroupId, userId, "xkeep");
        var drop = await SeedRecipeAsync(group.GroupId, userId, "xdrop");
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var r = await db.Recipes.SingleAsync(x => x.Id == drop);
            r.SoftDelete(DateTimeOffset.UtcNow);
            await db.SaveChangesAsync();
        }

        var body = await GetSearchAsync(_client, "q=x");

        Assert.Equal(1, body.Total);
        Assert.Equal(keep, body.Items[0].Id);
    }

    // ── Pathological page (overflow) ────────────────────────────────────

    [Fact]
    public async Task Search_Pathological_HugePage_Does_Not_Bypass_Pagination()
    {
        var (userId, token) = await SignupAndLoginAsync("huge@ex.com", "H");
        AuthorizeClient(_client, token);
        var group = await CreateGroupAsync(_client, "G");

        for (var i = 0; i < 3; i++) await SeedRecipeAsync(group.GroupId, userId, $"xhuge-{i}");

        var response = await _client.GetAsync(
            $"/api/recipes/search?q=xhuge&page={int.MaxValue}&pageSize=100");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = (await response.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeGlobalSearchListDto>())!;
        Assert.Empty(body.Items);
        Assert.Equal(3, body.Total);
        Assert.False(body.HasNextPage);
    }

    // ── Unauthenticated ─────────────────────────────────────────────────

    [Fact]
    public async Task Search_Unauthenticated_Returns_401()
    {
        using var anon = _factory.CreateRateLimitBypassingClient();
        var response = await anon.GetAsync("/api/recipes/search?q=x");
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    // ── Case-insensitive tag ILIKE ──────────────────────────────────────

    [Fact]
    public async Task Search_TagMatch_Is_CaseInsensitive()
    {
        var (userId, token) = await SignupAndLoginAsync("ci@ex.com", "CI");
        AuthorizeClient(_client, token);
        var group = await CreateGroupAsync(_client, "G");

        var tagId = await SeedGroupTagAsync(group.GroupId, userId, "Kimchi");
        var recipeId = await SeedRecipeAsync(group.GroupId, userId,
            title: "Bibimbap", tagIds: new[] { tagId });

        var body = await GetSearchAsync(_client, "q=KIMCHI");

        Assert.Equal(1, body.Total);
        Assert.Equal(recipeId, body.Items[0].Id);
    }
}
