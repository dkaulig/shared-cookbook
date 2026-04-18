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
/// End-to-end tests for the S6 recipe-revision endpoints. Sign-up, group
/// creation, and recipe CRUD all hit the real HTTP layer; the test
/// asserts that history rows appear, are bounded to 5, and that no-op
/// edits are not recorded.
/// </summary>
public class RecipeRevisionEndpointsTests : IClassFixture<FamilienKochbuchWebApplicationFactory>, IAsyncLifetime
{
    private readonly FamilienKochbuchWebApplicationFactory _factory;
    private HttpClient _client = null!;

    public RecipeRevisionEndpointsTests(FamilienKochbuchWebApplicationFactory factory)
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
        db.RecipeRevisions.RemoveRange(db.RecipeRevisions);
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

    // ── Helpers (mirroring RecipeEndpointsTests) ────────────────────────

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
        var create = await client.PostAsJsonAsync(
            "/api/groups",
            new GroupEndpoints.CreateGroupRequest(name, null, null));
        create.EnsureSuccessStatusCode();
        var body = (await create.Content.ReadFromJsonAsync<GroupEndpoints.GroupSummaryDto>())!;
        return body.Id;
    }

    private static RecipeEndpoints.CreateRecipeRequest BuildCreate(string title = "Spätzle") =>
        new(
            Title: title,
            Description: "Beschreibung",
            DefaultServings: 4,
            PrepTimeMinutes: 30,
            Difficulty: 1,
            SourceUrl: null,
            Ingredients: new[]
            {
                new RecipeEndpoints.IngredientRequest(0, 500m, "g", "Mehl", null, true),
                new RecipeEndpoints.IngredientRequest(1, 3m, "Stück", "Eier", null, true),
            },
            Steps: new[]
            {
                new RecipeEndpoints.StepRequest(0, "Schritt eins."),
                new RecipeEndpoints.StepRequest(1, "Schritt zwei."),
            },
            TagIds: Array.Empty<Guid>());

    private static RecipeEndpoints.UpdateRecipeRequest BuildUpdate(
        string title,
        IngredientChange ingredientChange = IngredientChange.None) =>
        new(
            Title: title,
            Description: "Beschreibung",
            DefaultServings: 4,
            PrepTimeMinutes: 30,
            Difficulty: 1,
            SourceUrl: null,
            Ingredients: ingredientChange == IngredientChange.AddOne
                ? new[]
                {
                    new RecipeEndpoints.IngredientRequest(0, 500m, "g", "Mehl", null, true),
                    new RecipeEndpoints.IngredientRequest(1, 3m, "Stück", "Eier", null, true),
                    new RecipeEndpoints.IngredientRequest(2, 100m, "g", "Salz", null, true),
                }
                : new[]
                {
                    new RecipeEndpoints.IngredientRequest(0, 500m, "g", "Mehl", null, true),
                    new RecipeEndpoints.IngredientRequest(1, 3m, "Stück", "Eier", null, true),
                },
            Steps: new[]
            {
                new RecipeEndpoints.StepRequest(0, "Schritt eins."),
                new RecipeEndpoints.StepRequest(1, "Schritt zwei."),
            },
            TagIds: Array.Empty<Guid>());

    private enum IngredientChange { None, AddOne }

    // ── Tests ───────────────────────────────────────────────────────────

    [Fact]
    public async Task Create_Records_One_Created_Revision()
    {
        var (_, token) = await SignupAndLoginAsync("revcr@ex.com", "RC");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);

        var create = await _client.PostAsJsonAsync($"/api/groups/{groupId}/recipes", BuildCreate("Pizza"));
        create.EnsureSuccessStatusCode();
        var recipe = (await create.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;

        var listRes = await _client.GetAsync($"/api/recipes/{recipe.Id}/revisions");
        Assert.Equal(HttpStatusCode.OK, listRes.StatusCode);
        var revisions = (await listRes.Content.ReadFromJsonAsync<RecipeRevisionEndpoints.RevisionSummaryDto[]>())!;
        var only = Assert.Single(revisions);
        Assert.Equal("Created", only.ChangeType);
        Assert.Equal("RC", only.ChangedBy.DisplayName);
    }

    [Fact]
    public async Task Edit_Records_Edited_Revision_With_DiffSummary()
    {
        var (_, token) = await SignupAndLoginAsync("revedit@ex.com", "RE");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);

        var create = await _client.PostAsJsonAsync($"/api/groups/{groupId}/recipes", BuildCreate("V1"));
        var recipe = (await create.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;

        var put = await _client.PutAsJsonAsync($"/api/recipes/{recipe.Id}", BuildUpdate("V2"));
        Assert.Equal(HttpStatusCode.OK, put.StatusCode);

        var listRes = await _client.GetAsync($"/api/recipes/{recipe.Id}/revisions");
        var revisions = (await listRes.Content.ReadFromJsonAsync<RecipeRevisionEndpoints.RevisionSummaryDto[]>())!;
        Assert.Equal(2, revisions.Length);

        // Newest first.
        Assert.Equal("Edited", revisions[0].ChangeType);
        Assert.False(string.IsNullOrWhiteSpace(revisions[0].DiffSummary));
        Assert.Contains("Titel", revisions[0].DiffSummary!);

        Assert.Equal("Created", revisions[1].ChangeType);
    }

    [Fact]
    public async Task Six_Distinct_Edits_Drop_Oldest_To_Five_Revisions()
    {
        var (_, token) = await SignupAndLoginAsync("revprune@ex.com", "RP");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);

        var create = await _client.PostAsJsonAsync($"/api/groups/{groupId}/recipes", BuildCreate("Base"));
        var recipe = (await create.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;

        // Six PUTs with distinct titles → 1 Created + 6 Edited = 7 total,
        // pruned to 5.
        for (var i = 0; i < 6; i++)
        {
            var put = await _client.PutAsJsonAsync(
                $"/api/recipes/{recipe.Id}", BuildUpdate($"E{i}"));
            put.EnsureSuccessStatusCode();
        }

        var listRes = await _client.GetAsync($"/api/recipes/{recipe.Id}/revisions");
        var revisions = (await listRes.Content.ReadFromJsonAsync<RecipeRevisionEndpoints.RevisionSummaryDto[]>())!;
        Assert.Equal(5, revisions.Length);
        Assert.All(revisions, r => Assert.Equal("Edited", r.ChangeType));
    }

    [Fact]
    public async Task NoOp_Edit_Does_Not_Add_A_Revision()
    {
        var (_, token) = await SignupAndLoginAsync("revnoop@ex.com", "RN");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);

        var create = await _client.PostAsJsonAsync($"/api/groups/{groupId}/recipes", BuildCreate("Stable"));
        var recipe = (await create.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;

        // PUT with the exact same body → snapshot identical → no revision.
        var put = await _client.PutAsJsonAsync($"/api/recipes/{recipe.Id}", BuildUpdate("Stable"));
        put.EnsureSuccessStatusCode();

        var listRes = await _client.GetAsync($"/api/recipes/{recipe.Id}/revisions");
        var revisions = (await listRes.Content.ReadFromJsonAsync<RecipeRevisionEndpoints.RevisionSummaryDto[]>())!;
        Assert.Single(revisions);
        Assert.Equal("Created", revisions[0].ChangeType);
    }

    [Fact]
    public async Task Fork_Records_Created_Revision_With_Source_Hint()
    {
        var (_, token) = await SignupAndLoginAsync("revfork@ex.com", "RF");
        AuthorizeClient(_client, token);
        var sourceGroupId = await CreateGroupAsync(_client, "Quelle");
        var targetGroupId = await CreateGroupAsync(_client, "Ziel");

        var create = await _client.PostAsJsonAsync(
            $"/api/groups/{sourceGroupId}/recipes", BuildCreate("Original"));
        var source = (await create.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;

        var fork = await _client.PostAsJsonAsync(
            $"/api/recipes/{source.Id}/fork",
            new RecipeEndpoints.ForkRecipeRequest(targetGroupId));
        fork.EnsureSuccessStatusCode();
        var forkBody = (await fork.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;

        var listRes = await _client.GetAsync($"/api/recipes/{forkBody.Id}/revisions");
        var revisions = (await listRes.Content.ReadFromJsonAsync<RecipeRevisionEndpoints.RevisionSummaryDto[]>())!;
        var only = Assert.Single(revisions);
        Assert.Equal("Created", only.ChangeType);
        Assert.False(string.IsNullOrWhiteSpace(only.DiffSummary));
        Assert.Contains("Geforkt", only.DiffSummary!);
    }

    [Fact]
    public async Task NonMember_Get_Revisions_403()
    {
        var (_, ownerToken) = await SignupAndLoginAsync("rev-own@ex.com", "Owner");
        var (_, otherToken) = await SignupAndLoginAsync("rev-out@ex.com", "Outsider");

        using var ownerClient = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(ownerClient, ownerToken);
        var groupId = await CreateGroupAsync(ownerClient);
        var create = await ownerClient.PostAsJsonAsync($"/api/groups/{groupId}/recipes", BuildCreate());
        var recipe = (await create.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;

        using var outsider = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(outsider, otherToken);
        var listRes = await outsider.GetAsync($"/api/recipes/{recipe.Id}/revisions");
        Assert.Equal(HttpStatusCode.Forbidden, listRes.StatusCode);
    }

    [Fact]
    public async Task Get_Specific_Revision_Returns_Snapshot()
    {
        var (_, token) = await SignupAndLoginAsync("rev-detail@ex.com", "RD");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);

        var create = await _client.PostAsJsonAsync($"/api/groups/{groupId}/recipes", BuildCreate("Snap"));
        var recipe = (await create.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;

        var listRes = await _client.GetAsync($"/api/recipes/{recipe.Id}/revisions");
        var revisions = (await listRes.Content.ReadFromJsonAsync<RecipeRevisionEndpoints.RevisionSummaryDto[]>())!;
        var revisionId = revisions[0].Id;

        var detailRes = await _client.GetAsync($"/api/recipes/{recipe.Id}/revisions/{revisionId}");
        Assert.Equal(HttpStatusCode.OK, detailRes.StatusCode);
        var detail = (await detailRes.Content.ReadFromJsonAsync<RecipeRevisionEndpoints.RevisionDetailDto>())!;
        Assert.Equal(revisionId, detail.Id);
        Assert.NotNull(detail.Snapshot);
        Assert.Equal("Snap", detail.Snapshot.Title);
        Assert.Equal(2, detail.Snapshot.Ingredients.Length);
        Assert.Equal(2, detail.Snapshot.Steps.Length);
    }

    [Fact]
    public async Task Get_Revision_Belonging_To_Other_Recipe_Returns_404()
    {
        var (_, token) = await SignupAndLoginAsync("rev-cross@ex.com", "RX");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);

        var createA = await _client.PostAsJsonAsync($"/api/groups/{groupId}/recipes", BuildCreate("A"));
        var recipeA = (await createA.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;
        var createB = await _client.PostAsJsonAsync($"/api/groups/{groupId}/recipes", BuildCreate("B"));
        var recipeB = (await createB.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;

        var listB = await _client.GetAsync($"/api/recipes/{recipeB.Id}/revisions");
        var revisionsB = (await listB.Content.ReadFromJsonAsync<RecipeRevisionEndpoints.RevisionSummaryDto[]>())!;
        var revisionBId = revisionsB[0].Id;

        // Try to fetch B's revision under A's path.
        var crossRes = await _client.GetAsync($"/api/recipes/{recipeA.Id}/revisions/{revisionBId}");
        Assert.Equal(HttpStatusCode.NotFound, crossRes.StatusCode);
    }

    // BF1 #2 — the seeded admin user must not surface as the literal role
    // string "Admin" in revision history. The previous seed hard-coded
    // DisplayName = "Admin" (the role label), confusing the recipient who
    // expected a person's name. We assert the seed now produces a
    // person-shaped display name that is distinct from the role enum name.
    [Fact]
    public async Task Seeded_Admin_Revision_Author_Is_Not_Role_Label()
    {
        var admin = await LoginAsync("admin@test.local", "AdminPassword123!");
        AuthorizeClient(_client, admin.AccessToken);
        var groupId = await CreateGroupAsync(_client, "Admin-Bezugsgruppe");

        var create = await _client.PostAsJsonAsync($"/api/groups/{groupId}/recipes", BuildCreate("Adminrezept"));
        create.EnsureSuccessStatusCode();
        var recipe = (await create.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;

        var listRes = await _client.GetAsync($"/api/recipes/{recipe.Id}/revisions");
        Assert.Equal(HttpStatusCode.OK, listRes.StatusCode);
        var revisions = (await listRes.Content.ReadFromJsonAsync<RecipeRevisionEndpoints.RevisionSummaryDto[]>())!;
        var only = Assert.Single(revisions);

        // Root-cause check: the projection must surface the user's
        // DisplayName, not the application Role enum value. Equally
        // important — the seed must not assign the role string itself
        // as a display name.
        Assert.False(string.IsNullOrWhiteSpace(only.ChangedBy.DisplayName));
        Assert.NotEqual(UserRole.Admin.ToString(), only.ChangedBy.DisplayName);
        Assert.NotEqual("Admin", only.ChangedBy.DisplayName);
        Assert.Equal(admin.User.DisplayName, only.ChangedBy.DisplayName);
    }

    [Fact]
    public async Task NonMember_Get_Specific_Revision_403()
    {
        var (_, ownerToken) = await SignupAndLoginAsync("rev2-own@ex.com", "Owner");
        var (_, otherToken) = await SignupAndLoginAsync("rev2-out@ex.com", "Out");

        using var ownerClient = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(ownerClient, ownerToken);
        var groupId = await CreateGroupAsync(ownerClient);
        var create = await ownerClient.PostAsJsonAsync($"/api/groups/{groupId}/recipes", BuildCreate());
        var recipe = (await create.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;

        var listOwner = await ownerClient.GetAsync($"/api/recipes/{recipe.Id}/revisions");
        var revisions = (await listOwner.Content.ReadFromJsonAsync<RecipeRevisionEndpoints.RevisionSummaryDto[]>())!;
        var revisionId = revisions[0].Id;

        using var outsider = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(outsider, otherToken);
        var detailRes = await outsider.GetAsync($"/api/recipes/{recipe.Id}/revisions/{revisionId}");
        Assert.Equal(HttpStatusCode.Forbidden, detailRes.StatusCode);
    }
}
