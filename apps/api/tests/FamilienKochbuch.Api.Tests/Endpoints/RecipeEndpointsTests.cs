using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
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
/// End-to-end tests for the S3 Recipe endpoints. Signs in real users via
/// the /api/auth flow so RBAC is exercised against the actual JWT
/// middleware; SQLite in-memory backs the DbContext; FakePhotoStorage
/// stands in for SeaweedFS.
/// </summary>
public class RecipeEndpointsTests : IClassFixture<FamilienKochbuchWebApplicationFactory>, IAsyncLifetime
{
    private readonly FamilienKochbuchWebApplicationFactory _factory;
    private HttpClient _client = null!;

    public RecipeEndpointsTests(FamilienKochbuchWebApplicationFactory factory)
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
        db.RecipeTags.RemoveRange(db.RecipeTags);
        db.Ingredients.RemoveRange(db.Ingredients);
        db.RecipeSteps.RemoveRange(db.RecipeSteps);
        // PF1 — clear any leftover staged-photo rows between tests so
        // FK + ownership assertions stay deterministic.
        db.StagedPhotos.RemoveRange(db.StagedPhotos);
        db.Recipes.RemoveRange(db.Recipes);
        // Custom (group-scoped) tags may accumulate across tests; global
        // seed tags stay.
        db.Tags.RemoveRange(db.Tags.Where(t => t.GroupId != null));
        db.GroupInvites.RemoveRange(db.GroupInvites);
        db.GroupMemberships.RemoveRange(db.GroupMemberships);
        db.Groups.RemoveRange(db.Groups);
        db.RefreshTokens.RemoveRange(db.RefreshTokens);
        db.AppInvites.RemoveRange(db.AppInvites);
        var nonAdmin = db.Users.Where(u => u.Email != "admin@test.local");
        db.Users.RemoveRange(nonAdmin);
        await db.SaveChangesAsync();

        // Seed the admin's Private Sammlung (cleared by the wipe above).
        var adminId = await db.Users.Where(u => u.Email == "admin@test.local").Select(u => u.Id).SingleAsync();
        var privateCollections = scope.ServiceProvider.GetRequiredService<IPrivateCollectionService>();
        await privateCollections.EnsurePrivateCollectionAsync(adminId);

        // The seed tags live in the migration path which EnsureCreatedAsync
        // does NOT run; seed a representative subset manually so /tags
        // endpoints have data.
        if (!await db.Tags.AnyAsync(t => t.GroupId == null))
        {
            db.Tags.Add(Domain.Entities.Tag.CreateGlobal("Frühstück", TagCategory.Mahlzeit));
            db.Tags.Add(Domain.Entities.Tag.CreateGlobal("Mittag", TagCategory.Mahlzeit));
            db.Tags.Add(Domain.Entities.Tag.CreateGlobal("Abend", TagCategory.Mahlzeit));
            db.Tags.Add(Domain.Entities.Tag.CreateGlobal("Snack", TagCategory.Mahlzeit));
            db.Tags.Add(Domain.Entities.Tag.CreateGlobal("Dessert", TagCategory.Mahlzeit));
            db.Tags.Add(Domain.Entities.Tag.CreateGlobal("Frühling", TagCategory.Saison));
            db.Tags.Add(Domain.Entities.Tag.CreateGlobal("Sommer", TagCategory.Saison));
            db.Tags.Add(Domain.Entities.Tag.CreateGlobal("Herbst", TagCategory.Saison));
            db.Tags.Add(Domain.Entities.Tag.CreateGlobal("Winter", TagCategory.Saison));
            db.Tags.Add(Domain.Entities.Tag.CreateGlobal("ganzjährig", TagCategory.Saison));
            db.Tags.Add(Domain.Entities.Tag.CreateGlobal("warm", TagCategory.Typ));
            db.Tags.Add(Domain.Entities.Tag.CreateGlobal("kalt", TagCategory.Typ));
            db.Tags.Add(Domain.Entities.Tag.CreateGlobal("deftig", TagCategory.Typ));
            db.Tags.Add(Domain.Entities.Tag.CreateGlobal("süß", TagCategory.Typ));
            db.Tags.Add(Domain.Entities.Tag.CreateGlobal("leicht", TagCategory.Typ));
            db.Tags.Add(Domain.Entities.Tag.CreateGlobal("schnell", TagCategory.Aufwand));
            db.Tags.Add(Domain.Entities.Tag.CreateGlobal("mittel", TagCategory.Aufwand));
            db.Tags.Add(Domain.Entities.Tag.CreateGlobal("aufwendig", TagCategory.Aufwand));
            db.Tags.Add(Domain.Entities.Tag.CreateGlobal("vegetarisch", TagCategory.Diaet));
            db.Tags.Add(Domain.Entities.Tag.CreateGlobal("vegan", TagCategory.Diaet));
            db.Tags.Add(Domain.Entities.Tag.CreateGlobal("glutenfrei", TagCategory.Diaet));
            db.Tags.Add(Domain.Entities.Tag.CreateGlobal("laktosefrei", TagCategory.Diaet));
            db.Tags.Add(Domain.Entities.Tag.CreateGlobal("deutsch", TagCategory.Kueche));
            db.Tags.Add(Domain.Entities.Tag.CreateGlobal("italienisch", TagCategory.Kueche));
            db.Tags.Add(Domain.Entities.Tag.CreateGlobal("asiatisch", TagCategory.Kueche));
            db.Tags.Add(Domain.Entities.Tag.CreateGlobal("mexikanisch", TagCategory.Kueche));
            db.Tags.Add(Domain.Entities.Tag.CreateGlobal("französisch", TagCategory.Kueche));
            db.Tags.Add(Domain.Entities.Tag.CreateGlobal("spanisch", TagCategory.Kueche));
            db.Tags.Add(Domain.Entities.Tag.CreateGlobal("indisch", TagCategory.Kueche));
            db.Tags.Add(Domain.Entities.Tag.CreateGlobal("orientalisch", TagCategory.Kueche));
            await db.SaveChangesAsync();
        }
    }

    // ── helpers ─────────────────────────────────────────────────────

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

    private async Task<Guid[]> GetSeededTagIdsAsync(int take)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        return await db.Tags.Where(t => t.GroupId == null)
            .OrderBy(t => t.Name)
            .Take(take)
            .Select(t => t.Id)
            .ToArrayAsync();
    }

    private static RecipeEndpoints.CreateRecipeRequest BuildCreateRequest(
        string title = "Spätzle",
        IReadOnlyList<Guid>? tagIds = null)
    {
        var ingredients = new[]
        {
            new RecipeEndpoints.IngredientRequest(0, 500m, "g", "Mehl", null, true),
            new RecipeEndpoints.IngredientRequest(1, 3m, "", "Eier", null, true),
            new RecipeEndpoints.IngredientRequest(2, null, "Prise", "Salz", null, false),
        };
        var steps = new[]
        {
            new RecipeEndpoints.StepRequest(0, "Mehl in eine Schüssel geben."),
            new RecipeEndpoints.StepRequest(1, "Eier und Salz hinzufügen, verquirlen."),
        };
        return new RecipeEndpoints.CreateRecipeRequest(
            Title: title,
            Description: "Selbstgemachte Spätzle",
            DefaultServings: 4,
            PrepTimeMinutes: 30,
            Difficulty: 1,
            SourceUrl: null,
            Ingredients: ingredients,
            Steps: steps,
            TagIds: tagIds?.ToArray() ?? Array.Empty<Guid>());
    }

    // ── POST /api/groups/{groupId}/recipes ──────────────────────────

    [Fact]
    public async Task CreateRecipe_Persists_Ingredients_Steps_And_Tags()
    {
        var (_, token) = await SignupAndLoginAsync("alice@ex.com", "Alice");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client, "Familie");
        var tagIds = await GetSeededTagIdsAsync(3);

        var response = await _client.PostAsJsonAsync(
            $"/api/groups/{groupId}/recipes",
            BuildCreateRequest("Spätzle", tagIds));

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var body = (await response.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;
        Assert.Equal("Spätzle", body.Title);
        Assert.Equal(3, body.Ingredients.Length);
        Assert.Equal(2, body.Steps.Length);
        Assert.Equal(3, body.Tags.Length);
        Assert.Contains(body.Ingredients, i => i.Name == "Salz" && i.Quantity == null && !i.Scalable);
    }

    [Fact]
    public async Task CreateRecipe_403_When_Not_Member()
    {
        var (_, aTok) = await SignupAndLoginAsync("a@ex.com", "A");
        var (_, bTok) = await SignupAndLoginAsync("b@ex.com", "B");

        using var clientA = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientA, aTok);
        var groupId = await CreateGroupAsync(clientA, "A-Group");

        using var clientB = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientB, bTok);

        var response = await clientB.PostAsJsonAsync(
            $"/api/groups/{groupId}/recipes",
            BuildCreateRequest("Forbidden"));

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task CreateRecipe_401_When_Unauthenticated()
    {
        var response = await _client.PostAsJsonAsync(
            $"/api/groups/{Guid.NewGuid()}/recipes",
            BuildCreateRequest());

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task CreateRecipe_400_On_Blank_Title()
    {
        var (_, token) = await SignupAndLoginAsync("title@ex.com", "T");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);

        var invalid = BuildCreateRequest("   ");
        var response = await _client.PostAsJsonAsync($"/api/groups/{groupId}/recipes", invalid);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    // ── P2-10 — Nutrition on create ─────────────────────────────────

    [Fact]
    public async Task CreateRecipe_Persists_NutritionEstimate_When_Supplied()
    {
        var (_, token) = await SignupAndLoginAsync("nutri@ex.com", "N");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);

        var request = BuildCreateRequest("Mit Nährwerten") with
        {
            NutritionEstimate = new RecipeEndpoints.NutritionEstimateRequest(420, 24, 38, 9),
        };
        var response = await _client.PostAsJsonAsync(
            $"/api/groups/{groupId}/recipes", request);

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var body = (await response.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;
        Assert.NotNull(body.NutritionEstimate);
        Assert.Equal(420, body.NutritionEstimate!.Kcal);
        Assert.Equal(24, body.NutritionEstimate.ProteinG);
        Assert.Equal(38, body.NutritionEstimate.CarbsG);
        Assert.Equal(9, body.NutritionEstimate.FatG);
    }

    [Fact]
    public async Task CreateRecipe_Returns_Null_NutritionEstimate_When_Omitted()
    {
        var (_, token) = await SignupAndLoginAsync("nutri-null@ex.com", "NN");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);

        // BuildCreateRequest omits the nutrition field — the response
        // must still carry the key (as ``null``) so the frontend isn't
        // surprised by a missing property.
        var response = await _client.PostAsJsonAsync(
            $"/api/groups/{groupId}/recipes", BuildCreateRequest("Ohne Nährwerte"));

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var body = (await response.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;
        Assert.Null(body.NutritionEstimate);
    }

    [Fact]
    public async Task CreateRecipe_400_On_OutOfRange_NutritionEstimate()
    {
        var (_, token) = await SignupAndLoginAsync("nutri-bad@ex.com", "NB");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);

        // kcal > 5000 is out of the domain bounds. The Python side
        // clamps before this ever reaches .NET, but a drift in the AI
        // pipeline / a direct-API caller must surface as a 400.
        var request = BuildCreateRequest("Hallu") with
        {
            NutritionEstimate = new RecipeEndpoints.NutritionEstimateRequest(99999, 10, 10, 10),
        };
        var response = await _client.PostAsJsonAsync(
            $"/api/groups/{groupId}/recipes", request);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    // ── PATCH /api/recipes/{id}/nutrition ──────────────────────────────

    private async Task<(Guid RecipeId, Guid GroupId)> CreateRecipeWithAuthorAsync(HttpClient client)
    {
        var groupId = await CreateGroupAsync(client);
        var createRes = await client.PostAsJsonAsync(
            $"/api/groups/{groupId}/recipes", BuildCreateRequest("Patch-Ziel"));
        var created = (await createRes.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;
        return (created.Id, groupId);
    }

    [Fact]
    public async Task PatchNutrition_Updates_Estimate_For_Author()
    {
        var (_, token) = await SignupAndLoginAsync("patch-author@ex.com", "PA");
        AuthorizeClient(_client, token);
        var (recipeId, _) = await CreateRecipeWithAuthorAsync(_client);

        var response = await _client.PatchAsJsonAsync(
            $"/api/recipes/{recipeId}/nutrition",
            new RecipeEndpoints.NutritionEstimateRequest(420, 24, 38, 9));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = (await response.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;
        Assert.NotNull(body.NutritionEstimate);
        Assert.Equal(420, body.NutritionEstimate!.Kcal);
        Assert.Equal(24, body.NutritionEstimate.ProteinG);
    }

    [Fact]
    public async Task PatchNutrition_Null_Body_Clears_Existing_Estimate()
    {
        var (_, token) = await SignupAndLoginAsync("patch-clear@ex.com", "PC");
        AuthorizeClient(_client, token);
        var (recipeId, _) = await CreateRecipeWithAuthorAsync(_client);
        await _client.PatchAsJsonAsync(
            $"/api/recipes/{recipeId}/nutrition",
            new RecipeEndpoints.NutritionEstimateRequest(300, 10, 30, 8));

        // Explicit null body: Serializer writes the literal `null` which
        // the endpoint treats as a clear-request.
        var clear = await _client.PatchAsync(
            $"/api/recipes/{recipeId}/nutrition",
            new StringContent("null", Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.OK, clear.StatusCode);
        var body = (await clear.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;
        Assert.Null(body.NutritionEstimate);
    }

    [Fact]
    public async Task PatchNutrition_400_When_Kcal_Out_Of_Range()
    {
        var (_, token) = await SignupAndLoginAsync("patch-range@ex.com", "PR");
        AuthorizeClient(_client, token);
        var (recipeId, _) = await CreateRecipeWithAuthorAsync(_client);

        var response = await _client.PatchAsJsonAsync(
            $"/api/recipes/{recipeId}/nutrition",
            new RecipeEndpoints.NutritionEstimateRequest(99999, 10, 10, 10));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task PatchNutrition_400_When_Protein_Out_Of_Range()
    {
        var (_, token) = await SignupAndLoginAsync("patch-protein@ex.com", "PP");
        AuthorizeClient(_client, token);
        var (recipeId, _) = await CreateRecipeWithAuthorAsync(_client);

        var response = await _client.PatchAsJsonAsync(
            $"/api/recipes/{recipeId}/nutrition",
            new RecipeEndpoints.NutritionEstimateRequest(400, 999, 10, 10));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task PatchNutrition_401_When_Unauthenticated()
    {
        var response = await _client.PatchAsJsonAsync(
            $"/api/recipes/{Guid.NewGuid()}/nutrition",
            new RecipeEndpoints.NutritionEstimateRequest(400, 10, 10, 10));

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task PatchNutrition_403_For_Non_Author_Non_Admin()
    {
        var (_, aTok) = await SignupAndLoginAsync("author@ex.com", "A");
        var (_, bTok) = await SignupAndLoginAsync("bystander@ex.com", "B");

        using var clientA = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientA, aTok);
        var (recipeId, groupId) = await CreateRecipeWithAuthorAsync(clientA);

        // Add B to the same group so the recipe is visible — but B is
        // neither author nor admin, so the PATCH must still 403.
        using var clientB = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientB, bTok);
        await InviteAndAcceptAsync(clientA, clientB, groupId, "bystander@ex.com");

        var response = await clientB.PatchAsJsonAsync(
            $"/api/recipes/{recipeId}/nutrition",
            new RecipeEndpoints.NutritionEstimateRequest(300, 10, 30, 8));

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task PatchNutrition_Allows_Admin_On_Other_Authors_Recipe()
    {
        var (_, authorTok) = await SignupAndLoginAsync("author-admin@ex.com", "AA");
        using var author = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(author, authorTok);
        var (recipeId, _) = await CreateRecipeWithAuthorAsync(author);

        // Log in the seeded admin (role=Admin) and PATCH the recipe.
        var admin = await LoginAsync("admin@test.local", "AdminPassword123!");
        AuthorizeClient(_client, admin.AccessToken);

        var response = await _client.PatchAsJsonAsync(
            $"/api/recipes/{recipeId}/nutrition",
            new RecipeEndpoints.NutritionEstimateRequest(550, 30, 40, 20));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = (await response.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;
        Assert.Equal(550, body.NutritionEstimate!.Kcal);
    }

    [Fact]
    public async Task PatchNutrition_404_For_Unknown_Recipe()
    {
        var (_, token) = await SignupAndLoginAsync("patch-404@ex.com", "P4");
        AuthorizeClient(_client, token);

        var response = await _client.PatchAsJsonAsync(
            $"/api/recipes/{Guid.NewGuid()}/nutrition",
            new RecipeEndpoints.NutritionEstimateRequest(400, 10, 10, 10));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    private async Task InviteAndAcceptAsync(
        HttpClient admin, HttpClient invitee, Guid groupId, string inviteeEmail)
    {
        // Look up the invitee's userId directly from the DB so the test
        // can invite them without going through the user-search API.
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var inviteeUser = await db.Users.SingleAsync(u => u.Email == inviteeEmail);

        var inviteRes = await admin.PostAsJsonAsync(
            $"/api/groups/{groupId}/invites",
            new GroupEndpoints.InviteToGroupRequest(inviteeUser.Id));
        inviteRes.EnsureSuccessStatusCode();
        var invite = (await inviteRes.Content.ReadFromJsonAsync<GroupEndpoints.GroupInviteDto>())!;

        var accept = await invitee.PostAsync($"/api/groups/invites/{invite.Id}/accept", null);
        accept.EnsureSuccessStatusCode();
    }

    // ── GET /api/recipes/{id} ───────────────────────────────────────

    [Fact]
    public async Task GetRecipe_Returns_Full_Detail()
    {
        var (_, token) = await SignupAndLoginAsync("getter@ex.com", "G");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var create = await _client.PostAsJsonAsync($"/api/groups/{groupId}/recipes",
            BuildCreateRequest("Pizza"));
        var created = (await create.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;

        var response = await _client.GetAsync($"/api/recipes/{created.Id}");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = (await response.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;
        Assert.Equal("Pizza", body.Title);
        Assert.Equal(3, body.Ingredients.Length);
        Assert.Equal(2, body.Steps.Length);
        // Steps must be ordered by Position.
        Assert.Equal(0, body.Steps[0].Position);
        Assert.Equal(1, body.Steps[1].Position);
    }

    [Fact]
    public async Task GetRecipe_Returns_403_For_Non_Member()
    {
        var (_, aTok) = await SignupAndLoginAsync("get-a@ex.com", "A");
        var (_, bTok) = await SignupAndLoginAsync("get-b@ex.com", "B");

        using var clientA = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientA, aTok);
        var groupId = await CreateGroupAsync(clientA);
        var createRes = await clientA.PostAsJsonAsync($"/api/groups/{groupId}/recipes", BuildCreateRequest());
        var created = (await createRes.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;

        using var clientB = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientB, bTok);
        var response = await clientB.GetAsync($"/api/recipes/{created.Id}");
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task GetRecipe_Returns_404_For_Unknown_Id()
    {
        var (_, token) = await SignupAndLoginAsync("nf@ex.com", "NF");
        AuthorizeClient(_client, token);

        var response = await _client.GetAsync($"/api/recipes/{Guid.NewGuid()}");
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    // ── GET /api/groups/{groupId}/recipes (list) ────────────────────

    [Fact]
    public async Task ListGroupRecipes_Returns_Summaries_For_Member()
    {
        var (_, token) = await SignupAndLoginAsync("list@ex.com", "L");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        await _client.PostAsJsonAsync($"/api/groups/{groupId}/recipes", BuildCreateRequest("A"));
        await _client.PostAsJsonAsync($"/api/groups/{groupId}/recipes", BuildCreateRequest("B"));

        var response = await _client.GetAsync($"/api/groups/{groupId}/recipes");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = (await response.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeSummaryListDto>())!;
        Assert.Equal(2, body.Total);
        Assert.Equal(2, body.Items.Length);
    }

    [Fact]
    public async Task ListGroupRecipes_Summary_Includes_Rating_Aggregates()
    {
        var (_, token) = await SignupAndLoginAsync("lr@ex.com", "LR");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var createRes = await _client.PostAsJsonAsync(
            $"/api/groups/{groupId}/recipes", BuildCreateRequest("Bewertet"));
        var recipe = (await createRes.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;
        await _client.PostAsJsonAsync($"/api/recipes/{recipe.Id}/ratings",
            new RatingEndpoints.UpsertRatingRequest(5, null));

        var response = await _client.GetAsync($"/api/groups/{groupId}/recipes");
        response.EnsureSuccessStatusCode();
        var body = (await response.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeSummaryListDto>())!;

        var summary = Assert.Single(body.Items);
        Assert.Equal(5.0, summary.AvgRating);
        Assert.Equal(1, summary.RatingCount);
        Assert.Equal(5, summary.MyStars);
    }

    [Fact]
    public async Task ListGroupRecipes_403_For_Non_Member()
    {
        var (_, aTok) = await SignupAndLoginAsync("la@ex.com", "A");
        var (_, bTok) = await SignupAndLoginAsync("lb@ex.com", "B");
        using var clientA = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientA, aTok);
        var groupId = await CreateGroupAsync(clientA);

        using var clientB = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientB, bTok);
        var response = await clientB.GetAsync($"/api/groups/{groupId}/recipes");
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    // ── PUT /api/recipes/{id} ───────────────────────────────────────

    [Fact]
    public async Task UpdateRecipe_Replaces_Ingredients_Wholesale()
    {
        var (_, token) = await SignupAndLoginAsync("upd@ex.com", "U");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);

        // Create 3-ingredient recipe.
        var create = await _client.PostAsJsonAsync($"/api/groups/{groupId}/recipes", BuildCreateRequest("Orig"));
        var created = (await create.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;

        // PUT with just 1 ingredient + 1 step.
        var replace = new RecipeEndpoints.UpdateRecipeRequest(
            Title: "Updated",
            Description: null,
            DefaultServings: 2,
            PrepTimeMinutes: 10,
            Difficulty: 2,
            SourceUrl: null,
            Ingredients: new[] { new RecipeEndpoints.IngredientRequest(0, 100m, "g", "Zucker", null, true) },
            Steps: new[] { new RecipeEndpoints.StepRequest(0, "Mischen.") },
            TagIds: Array.Empty<Guid>());

        var put = await _client.PutAsJsonAsync($"/api/recipes/{created.Id}", replace);
        Assert.Equal(HttpStatusCode.OK, put.StatusCode);

        var after = await _client.GetFromJsonAsync<RecipeEndpoints.RecipeDetailDto>(
            $"/api/recipes/{created.Id}");
        Assert.Equal("Updated", after!.Title);
        Assert.Single(after.Ingredients);
        Assert.Equal("Zucker", after.Ingredients[0].Name);
        Assert.Single(after.Steps);
        Assert.Empty(after.Tags);
    }

    [Fact]
    public async Task UpdateRecipe_403_For_Non_Member()
    {
        var (_, aTok) = await SignupAndLoginAsync("ua@ex.com", "A");
        var (_, bTok) = await SignupAndLoginAsync("ub@ex.com", "B");
        using var clientA = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientA, aTok);
        var groupId = await CreateGroupAsync(clientA);
        var createRes = await clientA.PostAsJsonAsync($"/api/groups/{groupId}/recipes", BuildCreateRequest());
        var created = (await createRes.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;

        using var clientB = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientB, bTok);
        var put = await clientB.PutAsJsonAsync($"/api/recipes/{created.Id}",
            new RecipeEndpoints.UpdateRecipeRequest(
                "Hack", null, 4, null, 1, null,
                Array.Empty<RecipeEndpoints.IngredientRequest>(),
                Array.Empty<RecipeEndpoints.StepRequest>(),
                Array.Empty<Guid>()));
        Assert.Equal(HttpStatusCode.Forbidden, put.StatusCode);
    }

    // ── DELETE /api/recipes/{id} ────────────────────────────────────

    [Fact]
    public async Task DeleteRecipe_SoftDeletes_And_Subsequent_Get_Returns_404()
    {
        var (_, token) = await SignupAndLoginAsync("del@ex.com", "D");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var createRes = await _client.PostAsJsonAsync($"/api/groups/{groupId}/recipes", BuildCreateRequest());
        var created = (await createRes.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;

        var del = await _client.DeleteAsync($"/api/recipes/{created.Id}");
        Assert.Equal(HttpStatusCode.NoContent, del.StatusCode);

        var get = await _client.GetAsync($"/api/recipes/{created.Id}");
        Assert.Equal(HttpStatusCode.NotFound, get.StatusCode);
    }

    [Fact]
    public async Task DeleteRecipe_403_For_Non_Member()
    {
        var (_, aTok) = await SignupAndLoginAsync("da@ex.com", "A");
        var (_, bTok) = await SignupAndLoginAsync("db@ex.com", "B");
        using var clientA = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientA, aTok);
        var groupId = await CreateGroupAsync(clientA);
        var createRes = await clientA.PostAsJsonAsync($"/api/groups/{groupId}/recipes", BuildCreateRequest());
        var created = (await createRes.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;

        using var clientB = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientB, bTok);
        var del = await clientB.DeleteAsync($"/api/recipes/{created.Id}");
        Assert.Equal(HttpStatusCode.Forbidden, del.StatusCode);
    }

    // ── POST /api/recipes/{id}/photos ───────────────────────────────

    private static MultipartFormDataContent BuildPhoto(byte[] bytes, string filename, string contentType)
    {
        var content = new MultipartFormDataContent();
        var file = new ByteArrayContent(bytes);
        file.Headers.ContentType = new MediaTypeHeaderValue(contentType);
        content.Add(file, "file", filename);
        return content;
    }

    private static byte[] ValidPngBytes()
    {
        // Smallest-possible PNG header + IEND chunk — fits well under 5 MB.
        return
        [
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
            0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
            0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
            0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
            0x89, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E,
            0x44, 0xAE, 0x42, 0x60, 0x82,
        ];
    }

    [Fact]
    public async Task UploadPhoto_Returns_200_With_Signed_Url_And_Stores_Bare_Path()
    {
        var (_, token) = await SignupAndLoginAsync("up@ex.com", "U");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var createRes = await _client.PostAsJsonAsync($"/api/groups/{groupId}/recipes", BuildCreateRequest());
        var created = (await createRes.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;

        using var content = BuildPhoto(ValidPngBytes(), "photo.png", "image/png");
        var response = await _client.PostAsync($"/api/recipes/{created.Id}/photos", content);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = (await response.Content.ReadFromJsonAsync<RecipeEndpoints.UploadPhotoResponse>())!;
        // Response URL is a signed proxy URL.
        Assert.StartsWith("/api/photos/recipes/", body.Url);
        Assert.Contains("?sig=", body.Url);
        Assert.Contains("&exp=", body.Url);

        // Detail response also surfaces the signed URL for the photo array.
        var detail = await _client.GetFromJsonAsync<RecipeEndpoints.RecipeDetailDto>($"/api/recipes/{created.Id}");
        Assert.Single(detail!.Photos);
        Assert.StartsWith("/api/photos/recipes/", detail.Photos[0]);
        Assert.Contains("?sig=", detail.Photos[0]);

        // But the DB stores only the bare path (no query, no signature).
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var dbRecipe = await db.Recipes.SingleAsync(r => r.Id == created.Id);
        var stored = Assert.Single(dbRecipe.Photos);
        Assert.StartsWith("recipes/", stored);
        Assert.DoesNotContain("?", stored);
        Assert.DoesNotContain("sig=", stored);
    }

    [Fact]
    public async Task UploadPhoto_Rejects_Fourth_Upload()
    {
        var (_, token) = await SignupAndLoginAsync("p4@ex.com", "P");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var createRes = await _client.PostAsJsonAsync($"/api/groups/{groupId}/recipes", BuildCreateRequest());
        var created = (await createRes.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;

        for (int i = 0; i < 3; i++)
        {
            using var ok = BuildPhoto(ValidPngBytes(), $"{i}.png", "image/png");
            var okRes = await _client.PostAsync($"/api/recipes/{created.Id}/photos", ok);
            okRes.EnsureSuccessStatusCode();
        }

        using var fourth = BuildPhoto(ValidPngBytes(), "4.png", "image/png");
        var response = await _client.PostAsync($"/api/recipes/{created.Id}/photos", fourth);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task UploadPhoto_Rejects_Invalid_Content_Type()
    {
        var (_, token) = await SignupAndLoginAsync("pct@ex.com", "P");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var createRes = await _client.PostAsJsonAsync($"/api/groups/{groupId}/recipes", BuildCreateRequest());
        var created = (await createRes.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;

        using var content = BuildPhoto(Encoding.UTF8.GetBytes("not an image"), "a.txt", "text/plain");
        var response = await _client.PostAsync($"/api/recipes/{created.Id}/photos", content);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task UploadPhoto_Rejects_Oversize()
    {
        var (_, token) = await SignupAndLoginAsync("psz@ex.com", "P");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var createRes = await _client.PostAsJsonAsync($"/api/groups/{groupId}/recipes", BuildCreateRequest());
        var created = (await createRes.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;

        // 6 MB is above the 5 MB limit.
        var big = new byte[6 * 1024 * 1024];
        using var content = BuildPhoto(big, "big.png", "image/png");
        var response = await _client.PostAsync($"/api/recipes/{created.Id}/photos", content);
        Assert.True(
            response.StatusCode == HttpStatusCode.BadRequest ||
            response.StatusCode == HttpStatusCode.RequestEntityTooLarge,
            $"Expected 400 or 413, got {response.StatusCode}");
    }

    [Fact]
    public async Task UploadPhoto_401_When_Unauthorized()
    {
        using var content = BuildPhoto(ValidPngBytes(), "photo.png", "image/png");
        var response = await _client.PostAsync($"/api/recipes/{Guid.NewGuid()}/photos", content);
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    // ── POST /api/recipes/photos/staged (P2-8) ──────────────────────

    [Fact]
    public async Task UploadStagedPhoto_Returns_200_With_PhotoId_And_Signed_Url()
    {
        var (_, token) = await SignupAndLoginAsync("staged1@ex.com", "S");
        AuthorizeClient(_client, token);

        using var content = BuildPhoto(ValidPngBytes(), "photo.png", "image/png");
        var response = await _client.PostAsync("/api/recipes/photos/staged", content);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = (await response.Content.ReadFromJsonAsync<RecipeEndpoints.StagedPhotoResponse>())!;

        // photoId is a bare storage path — no scheme, no query.
        Assert.StartsWith("recipes/", body.PhotoId);
        Assert.DoesNotContain("?", body.PhotoId);
        Assert.DoesNotContain("http", body.PhotoId);

        // signedUrl is the same path routed through the /api/photos
        // proxy with a valid signature that the import-endpoint will
        // accept.
        Assert.StartsWith("/api/photos/recipes/", body.SignedUrl);
        Assert.Contains("?sig=", body.SignedUrl);
        Assert.Contains("&exp=", body.SignedUrl);

        // Bytes actually landed in the storage fake.
        Assert.True(_factory.Photos.Uploads.ContainsKey(body.PhotoId));

        // PF1 — the response now also carries a non-empty stagedPhotoId
        // (the StagedPhoto row's domain key) so the create-recipe
        // promote flow can adopt the blob later.
        Assert.NotEqual(Guid.Empty, body.StagedPhotoId);
    }

    [Fact]
    public async Task UploadStagedPhoto_Inserts_StagedPhoto_Row_Owned_By_Caller()
    {
        var (userId, token) = await SignupAndLoginAsync("staged-row@ex.com", "SR");
        AuthorizeClient(_client, token);

        using var content = BuildPhoto(ValidPngBytes(), "photo.png", "image/png");
        var response = await _client.PostAsync("/api/recipes/photos/staged", content);
        response.EnsureSuccessStatusCode();
        var body = (await response.Content.ReadFromJsonAsync<RecipeEndpoints.StagedPhotoResponse>())!;

        // PF1 — verify the row was actually persisted with the right
        // owner + storage key, and is NOT yet marked promoted.
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var staged = await db.StagedPhotos.SingleAsync(s => s.Id == body.StagedPhotoId);
        Assert.Equal(userId, staged.UserId);
        Assert.Equal(body.PhotoId, staged.PhotoId);
        Assert.Equal(body.SignedUrl, staged.SignedUrl);
        Assert.Equal("image/png", staged.ContentType);
        Assert.Null(staged.PromotedAt);
        Assert.Null(staged.PromotedToRecipeId);
    }

    [Fact]
    public async Task UploadStagedPhoto_Rejects_Non_Image_With_400()
    {
        var (_, token) = await SignupAndLoginAsync("staged2@ex.com", "S");
        AuthorizeClient(_client, token);

        using var content = BuildPhoto(Encoding.UTF8.GetBytes("not an image"), "a.txt", "text/plain");
        var response = await _client.PostAsync("/api/recipes/photos/staged", content);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task UploadStagedPhoto_Rejects_Heic_With_400_And_German_Message()
    {
        var (_, token) = await SignupAndLoginAsync("staged-heic@ex.com", "S");
        AuthorizeClient(_client, token);

        // HEIC is the iOS default — the plan explicitly rejects it in
        // v1 with a clear German message nudging the user to re-export.
        using var content = BuildPhoto(ValidPngBytes(), "photo.heic", "image/heic");
        var response = await _client.PostAsync("/api/recipes/photos/staged", content);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadAsStringAsync();
        Assert.Contains("JPG", body, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task UploadStagedPhoto_401_When_Unauthorized()
    {
        using var content = BuildPhoto(ValidPngBytes(), "photo.png", "image/png");
        var response = await _client.PostAsync("/api/recipes/photos/staged", content);
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task UploadStagedPhoto_Rejects_Oversize()
    {
        var (_, token) = await SignupAndLoginAsync("staged-big@ex.com", "S");
        AuthorizeClient(_client, token);

        // 6 MB is above the 5 MB cap — ASP.NET's form-multipart limit
        // kicks in before the handler does for this size so the status
        // can be 400 or 413 depending on the middleware path. We accept
        // both, consistent with the live UploadPhoto path.
        var big = new byte[6 * 1024 * 1024];
        using var content = BuildPhoto(big, "big.png", "image/png");
        var response = await _client.PostAsync("/api/recipes/photos/staged", content);
        Assert.True(
            response.StatusCode == HttpStatusCode.BadRequest ||
            response.StatusCode == HttpStatusCode.RequestEntityTooLarge,
            $"Expected 400 or 413, got {response.StatusCode}");
    }

    // ── BUG-024 — DELETE /api/staged-photos/{id} ────────────────────

    [Fact]
    public async Task DeleteStagedPhoto_Removes_Row_And_Blob_For_Owner()
    {
        var (_, token) = await SignupAndLoginAsync("staged-del-owner@ex.com", "D");
        AuthorizeClient(_client, token);

        using var upload = BuildPhoto(ValidPngBytes(), "photo.png", "image/png");
        var uploadRes = await _client.PostAsync("/api/recipes/photos/staged", upload);
        uploadRes.EnsureSuccessStatusCode();
        var body = (await uploadRes.Content.ReadFromJsonAsync<RecipeEndpoints.StagedPhotoResponse>())!;
        Assert.True(_factory.Photos.Uploads.ContainsKey(body.PhotoId));

        var response = await _client.DeleteAsync($"/api/staged-photos/{body.StagedPhotoId}");
        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        Assert.False(await db.StagedPhotos.AnyAsync(s => s.Id == body.StagedPhotoId));
        // Blob is deleted best-effort; the fake storage honours the call.
        Assert.False(_factory.Photos.Uploads.ContainsKey(body.PhotoId));
    }

    [Fact]
    public async Task DeleteStagedPhoto_401_When_Unauthorized()
    {
        var response = await _client.DeleteAsync($"/api/staged-photos/{Guid.NewGuid()}");
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task DeleteStagedPhoto_403_When_Caller_Does_Not_Own_Row()
    {
        // Uploader: Alice.
        var (_, aliceToken) = await SignupAndLoginAsync("staged-del-alice@ex.com", "A");
        AuthorizeClient(_client, aliceToken);
        using var upload = BuildPhoto(ValidPngBytes(), "photo.png", "image/png");
        var uploadRes = await _client.PostAsync("/api/recipes/photos/staged", upload);
        uploadRes.EnsureSuccessStatusCode();
        var body = (await uploadRes.Content.ReadFromJsonAsync<RecipeEndpoints.StagedPhotoResponse>())!;

        // Switch client to Bob (a different authenticated user).
        var (_, bobToken) = await SignupAndLoginAsync("staged-del-bob@ex.com", "B");
        AuthorizeClient(_client, bobToken);

        var response = await _client.DeleteAsync($"/api/staged-photos/{body.StagedPhotoId}");
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);

        // Row survives — the 403 must NOT have side effects.
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        Assert.True(await db.StagedPhotos.AnyAsync(s => s.Id == body.StagedPhotoId));
    }

    [Fact]
    public async Task DeleteStagedPhoto_404_For_Unknown_Id()
    {
        var (_, token) = await SignupAndLoginAsync("staged-del-404@ex.com", "D");
        AuthorizeClient(_client, token);

        var response = await _client.DeleteAsync($"/api/staged-photos/{Guid.NewGuid()}");
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    // ── PF1 — create-recipe with stagedPhotoIds (promote flow) ──────

    private async Task<Guid> UploadStagedPhotoAndGetIdAsync(HttpClient client)
    {
        using var content = BuildPhoto(ValidPngBytes(), "photo.png", "image/png");
        var response = await client.PostAsync("/api/recipes/photos/staged", content);
        response.EnsureSuccessStatusCode();
        var body = (await response.Content.ReadFromJsonAsync<RecipeEndpoints.StagedPhotoResponse>())!;
        return body.StagedPhotoId;
    }

    [Fact]
    public async Task CreateRecipe_With_StagedPhotos_Attaches_Them_And_Marks_Promoted()
    {
        var (userId, token) = await SignupAndLoginAsync("promote@ex.com", "P");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client, "Promote-Family");

        // Stage 2 photos.
        var staged1 = await UploadStagedPhotoAndGetIdAsync(_client);
        var staged2 = await UploadStagedPhotoAndGetIdAsync(_client);

        // Create the recipe carrying both ids.
        var request = BuildCreateRequest("Promote-Test") with
        {
            StagedPhotoIds = new[] { staged1, staged2 },
        };
        var response = await _client.PostAsJsonAsync(
            $"/api/groups/{groupId}/recipes", request);
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);

        var body = (await response.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;
        Assert.Equal(2, body.Photos.Length);
        Assert.True(body.PartialPhotoFailures is null || body.PartialPhotoFailures.Length == 0);

        // The photo URLs are signed proxies pointing at recipes/* paths.
        Assert.All(body.Photos, p => Assert.Contains("/api/photos/recipes/", p));

        // Verify StagedPhoto rows were marked as promoted with the
        // recipe id, and the source blobs were cleaned up.
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var promoted = await db.StagedPhotos
            .Where(s => s.Id == staged1 || s.Id == staged2)
            .ToListAsync();
        Assert.Equal(2, promoted.Count);
        Assert.All(promoted, p =>
        {
            Assert.NotNull(p.PromotedAt);
            Assert.Equal(body.Id, p.PromotedToRecipeId);
        });

        // Source staged blobs got deleted by the fire-and-forget path.
        // On CI the delete is still in-flight when the HTTP response
        // returns; poll briefly.
        await PollUntilAsync(
            () => promoted.All(p => _factory.Photos.Deleted.Contains(p.PhotoId)),
            timeout: TimeSpan.FromSeconds(5),
            description: "staged-blob delete to complete");
        // userId silenced — not used in this assertion path; only the
        // ownership filter test exercises it.
        _ = userId;
    }

    [Fact]
    public async Task CreateRecipe_With_StagedPhotos_Wrong_Owner_Filtered_Into_PartialFailures()
    {
        // Another user uploads a staged photo; the creator should NOT
        // be able to attach it. The recipe creation succeeds with the
        // bad id moved into partialPhotoFailures.
        var (_, otherToken) = await SignupAndLoginAsync("other@ex.com", "O");
        using var otherClient = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(otherClient, otherToken);
        var foreignStagedId = await UploadStagedPhotoAndGetIdAsync(otherClient);

        var (_, callerToken) = await SignupAndLoginAsync("caller@ex.com", "C");
        AuthorizeClient(_client, callerToken);
        var groupId = await CreateGroupAsync(_client, "Caller-Family");

        var request = BuildCreateRequest("Forbidden-Foto") with
        {
            StagedPhotoIds = new[] { foreignStagedId },
        };
        var response = await _client.PostAsJsonAsync(
            $"/api/groups/{groupId}/recipes", request);
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);

        var body = (await response.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;
        Assert.Empty(body.Photos);
        Assert.NotNull(body.PartialPhotoFailures);
        var failure = Assert.Single(body.PartialPhotoFailures!);
        Assert.Equal(foreignStagedId, failure.StagedPhotoId);
        Assert.Contains("gehört nicht dir", failure.Reason);

        // The foreign staged photo row stays untouched (still owned by
        // the other user, still un-promoted).
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var staged = await db.StagedPhotos.SingleAsync(s => s.Id == foreignStagedId);
        Assert.Null(staged.PromotedAt);
    }

    [Fact]
    public async Task CreateRecipe_With_StagedPhotos_Already_Promoted_Lands_In_PartialFailures()
    {
        var (_, token) = await SignupAndLoginAsync("twice@ex.com", "T");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);

        var stagedId = await UploadStagedPhotoAndGetIdAsync(_client);

        // First create succeeds — photo attached.
        var first = await _client.PostAsJsonAsync(
            $"/api/groups/{groupId}/recipes",
            BuildCreateRequest("First") with { StagedPhotoIds = new[] { stagedId } });
        Assert.Equal(HttpStatusCode.Created, first.StatusCode);

        // Second create with the SAME stagedPhotoId — must skip
        // gracefully and surface a partial-failure entry.
        var second = await _client.PostAsJsonAsync(
            $"/api/groups/{groupId}/recipes",
            BuildCreateRequest("Second") with { StagedPhotoIds = new[] { stagedId } });
        Assert.Equal(HttpStatusCode.Created, second.StatusCode);
        var body = (await second.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;
        Assert.Empty(body.Photos);
        Assert.NotNull(body.PartialPhotoFailures);
        var failure = Assert.Single(body.PartialPhotoFailures!);
        Assert.Equal(stagedId, failure.StagedPhotoId);
        Assert.Contains("bereits", failure.Reason);
    }

    [Fact]
    public async Task CreateRecipe_With_Unknown_StagedPhotoId_Lands_In_PartialFailures()
    {
        var (_, token) = await SignupAndLoginAsync("ghost@ex.com", "G");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);

        var unknown = Guid.NewGuid();
        var response = await _client.PostAsJsonAsync(
            $"/api/groups/{groupId}/recipes",
            BuildCreateRequest("Ghost") with { StagedPhotoIds = new[] { unknown } });
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);

        var body = (await response.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;
        Assert.Empty(body.Photos);
        Assert.NotNull(body.PartialPhotoFailures);
        var failure = Assert.Single(body.PartialPhotoFailures!);
        Assert.Equal(unknown, failure.StagedPhotoId);
        Assert.Contains("nicht gefunden", failure.Reason);
    }

    [Fact]
    public async Task CreateRecipe_With_No_StagedPhotos_Returns_Null_PartialFailures()
    {
        // Backward-compat path: a manual create without stagedPhotoIds
        // must NOT carry a partialPhotoFailures payload — the
        // existing frontend doesn't expect one.
        var (_, token) = await SignupAndLoginAsync("plain@ex.com", "PL");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);

        var response = await _client.PostAsJsonAsync(
            $"/api/groups/{groupId}/recipes", BuildCreateRequest("Plain"));
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var body = (await response.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;
        Assert.Null(body.PartialPhotoFailures);
    }

    // ── DELETE /api/recipes/{id}/photos ─────────────────────────────

    [Fact]
    public async Task DeletePhoto_Accepts_Signed_Url_And_Removes_From_Array_And_Storage()
    {
        var (_, token) = await SignupAndLoginAsync("delp@ex.com", "D");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var createRes = await _client.PostAsJsonAsync($"/api/groups/{groupId}/recipes", BuildCreateRequest());
        var created = (await createRes.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;

        using var form = BuildPhoto(ValidPngBytes(), "photo.png", "image/png");
        var uploadRes = await _client.PostAsync($"/api/recipes/{created.Id}/photos", form);
        uploadRes.EnsureSuccessStatusCode();
        var upload = (await uploadRes.Content.ReadFromJsonAsync<RecipeEndpoints.UploadPhotoResponse>())!;

        // Client sends back the signed URL it received; endpoint must normalize
        // it to the bare path internally.
        using var req = new HttpRequestMessage(
            HttpMethod.Delete,
            $"/api/recipes/{created.Id}/photos")
        {
            Content = JsonContent.Create(new RecipeEndpoints.RemovePhotoRequest(upload.Url)),
        };
        var response = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);

        var detail = await _client.GetFromJsonAsync<RecipeEndpoints.RecipeDetailDto>($"/api/recipes/{created.Id}");
        Assert.Empty(detail!.Photos);

        // FakePhotoStorage records the normalized bare path (not the signed URL).
        var expectedPath = SeaweedFsPhotoStorage.NormalizeToPath(upload.Url);
        Assert.Contains(expectedPath, _factory.Photos.Deleted);

        // DB state: photo array is empty.
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var dbRecipe = await db.Recipes.SingleAsync(r => r.Id == created.Id);
        Assert.Empty(dbRecipe.Photos);
    }

    [Fact]
    public async Task DeletePhoto_Accepts_Bare_Path()
    {
        var (_, token) = await SignupAndLoginAsync("delp2@ex.com", "D2");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var createRes = await _client.PostAsJsonAsync($"/api/groups/{groupId}/recipes", BuildCreateRequest());
        var created = (await createRes.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;

        using var form = BuildPhoto(ValidPngBytes(), "photo.png", "image/png");
        var uploadRes = await _client.PostAsync($"/api/recipes/{created.Id}/photos", form);
        uploadRes.EnsureSuccessStatusCode();

        // Look up the stored path directly and pass it to delete.
        string storedPath;
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            storedPath = (await db.Recipes.SingleAsync(r => r.Id == created.Id)).Photos[0];
        }

        using var req = new HttpRequestMessage(
            HttpMethod.Delete,
            $"/api/recipes/{created.Id}/photos")
        {
            Content = JsonContent.Create(new RecipeEndpoints.RemovePhotoRequest(storedPath)),
        };
        var response = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);

        Assert.Contains(storedPath, _factory.Photos.Deleted);
    }

    // ── GET /api/groups/{groupId}/tags ──────────────────────────────

    [Fact]
    public async Task GetGroupTags_Returns_Global_Plus_GroupScoped_For_Member()
    {
        var (_, token) = await SignupAndLoginAsync("tag@ex.com", "T");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);

        var response = await _client.GetAsync($"/api/groups/{groupId}/tags");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var tags = (await response.Content.ReadFromJsonAsync<RecipeEndpoints.TagDto[]>())!;
        Assert.True(tags.Length >= 30, $"Expected ≥30 tags, got {tags.Length}");
        Assert.All(tags, t => Assert.True(t.IsGlobal || t.GroupId == groupId));
    }

    [Fact]
    public async Task GetGroupTags_403_For_Non_Member()
    {
        var (_, aTok) = await SignupAndLoginAsync("tg-a@ex.com", "A");
        var (_, bTok) = await SignupAndLoginAsync("tg-b@ex.com", "B");
        using var clientA = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientA, aTok);
        var groupId = await CreateGroupAsync(clientA);

        using var clientB = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientB, bTok);
        var response = await clientB.GetAsync($"/api/groups/{groupId}/tags");
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    // ── POST /api/recipes/{id}/fork ─────────────────────────────────

    private async Task AddMembershipAsync(Guid groupId, Guid userId, Domain.Enums.GroupRole role)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var existing = await db.GroupMemberships
            .FirstOrDefaultAsync(m => m.GroupId == groupId && m.UserId == userId);
        if (existing is not null) return;
        var m = new Domain.Entities.GroupMembership(userId, groupId, role, DateTimeOffset.UtcNow);
        db.GroupMemberships.Add(m);
        await db.SaveChangesAsync();
    }

    [Fact]
    public async Task Fork_Happy_Path_Copies_Recipe_Into_Target_Group()
    {
        var (_, token) = await SignupAndLoginAsync("fork-1@ex.com", "Forker");
        AuthorizeClient(_client, token);
        var sourceGroupId = await CreateGroupAsync(_client, "Source");
        var targetGroupId = await CreateGroupAsync(_client, "Target");
        var tagIds = await GetSeededTagIdsAsync(2);

        var createRes = await _client.PostAsJsonAsync(
            $"/api/groups/{sourceGroupId}/recipes",
            BuildCreateRequest("Original", tagIds));
        var original = (await createRes.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;

        var forkRes = await _client.PostAsJsonAsync(
            $"/api/recipes/{original.Id}/fork",
            new { targetGroupId });

        Assert.Equal(HttpStatusCode.Created, forkRes.StatusCode);
        var forked = (await forkRes.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;
        Assert.NotEqual(original.Id, forked.Id);
        Assert.Equal(targetGroupId, forked.GroupId);
        Assert.Equal(original.Id, forked.ForkOfRecipeId);
        Assert.Equal(original.Title, forked.Title);
        Assert.Equal(original.Description, forked.Description);
        Assert.Equal(original.DefaultServings, forked.DefaultServings);
        Assert.Equal(original.PrepTimeMinutes, forked.PrepTimeMinutes);
        Assert.Equal(original.Difficulty, forked.Difficulty);
        Assert.Equal(original.Ingredients.Length, forked.Ingredients.Length);
        Assert.Equal(original.Steps.Length, forked.Steps.Length);
        Assert.Equal(original.Tags.Length, forked.Tags.Length);
        // Global tag ids preserved verbatim.
        var originalTagIds = original.Tags.Select(t => t.Id).OrderBy(x => x).ToArray();
        var forkedTagIds = forked.Tags.Select(t => t.Id).OrderBy(x => x).ToArray();
        Assert.Equal(originalTagIds, forkedTagIds);

        // Ingredient & step order preserved.
        for (int i = 0; i < original.Ingredients.Length; i++)
        {
            Assert.Equal(original.Ingredients[i].Position, forked.Ingredients[i].Position);
            Assert.Equal(original.Ingredients[i].Name, forked.Ingredients[i].Name);
            Assert.Equal(original.Ingredients[i].Quantity, forked.Ingredients[i].Quantity);
            Assert.Equal(original.Ingredients[i].Unit, forked.Ingredients[i].Unit);
            Assert.Equal(original.Ingredients[i].Scalable, forked.Ingredients[i].Scalable);
            // New row → different id.
            Assert.NotEqual(original.Ingredients[i].Id, forked.Ingredients[i].Id);
        }
        for (int i = 0; i < original.Steps.Length; i++)
        {
            Assert.Equal(original.Steps[i].Position, forked.Steps[i].Position);
            Assert.Equal(original.Steps[i].Content, forked.Steps[i].Content);
            Assert.NotEqual(original.Steps[i].Id, forked.Steps[i].Id);
        }
    }

    [Fact]
    public async Task Fork_Returns_403_When_User_Is_Not_Member_Of_Target_Group()
    {
        var (_, aTok) = await SignupAndLoginAsync("fork-a@ex.com", "A");
        var (_, bTok) = await SignupAndLoginAsync("fork-b@ex.com", "B");

        using var clientA = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientA, aTok);
        var aGroup = await CreateGroupAsync(clientA, "A-Group");
        var createRes = await clientA.PostAsJsonAsync(
            $"/api/groups/{aGroup}/recipes",
            BuildCreateRequest("Only-A"));
        var original = (await createRes.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;

        using var clientB = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientB, bTok);
        var bGroup = await CreateGroupAsync(clientB, "B-Group");

        // A attempts to fork into B's group — A isn't a member of B's group.
        var forkRes = await clientA.PostAsJsonAsync(
            $"/api/recipes/{original.Id}/fork",
            new { targetGroupId = bGroup });
        Assert.Equal(HttpStatusCode.Forbidden, forkRes.StatusCode);
    }

    [Fact]
    public async Task Fork_Returns_403_When_User_Is_Not_Member_Of_Source_Group()
    {
        var (_, aTok) = await SignupAndLoginAsync("fork-src-a@ex.com", "A");
        var (_, bTok) = await SignupAndLoginAsync("fork-src-b@ex.com", "B");

        using var clientA = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientA, aTok);
        var aGroup = await CreateGroupAsync(clientA, "A-Secret");
        var createRes = await clientA.PostAsJsonAsync(
            $"/api/groups/{aGroup}/recipes",
            BuildCreateRequest("A-Secret"));
        var original = (await createRes.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;

        using var clientB = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientB, bTok);
        var bGroup = await CreateGroupAsync(clientB, "B-Group");

        // B attempts to fork A's recipe (B isn't a member of A's group).
        var forkRes = await clientB.PostAsJsonAsync(
            $"/api/recipes/{original.Id}/fork",
            new { targetGroupId = bGroup });
        Assert.Equal(HttpStatusCode.Forbidden, forkRes.StatusCode);
    }

    [Fact]
    public async Task Fork_Into_Same_Group_Creates_Independent_Copy()
    {
        var (_, token) = await SignupAndLoginAsync("fork-same@ex.com", "Same");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client, "Only-Group");

        var createRes = await _client.PostAsJsonAsync(
            $"/api/groups/{groupId}/recipes", BuildCreateRequest("Echo"));
        var original = (await createRes.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;

        var forkRes = await _client.PostAsJsonAsync(
            $"/api/recipes/{original.Id}/fork",
            new { targetGroupId = groupId });
        Assert.Equal(HttpStatusCode.Created, forkRes.StatusCode);
        var forked = (await forkRes.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;
        Assert.Equal(groupId, forked.GroupId);
        Assert.NotEqual(original.Id, forked.Id);
        Assert.Equal(original.Id, forked.ForkOfRecipeId);
    }

    [Fact]
    public async Task Fork_Drops_Group_Scoped_Tag_When_Target_Has_No_Matching_Custom_Tag()
    {
        var (userId, token) = await SignupAndLoginAsync("fork-tag@ex.com", "T");
        AuthorizeClient(_client, token);
        var sourceGroupId = await CreateGroupAsync(_client, "Source");
        var targetGroupId = await CreateGroupAsync(_client, "Target");

        // Create a custom tag in the source group only.
        Guid customTagId;
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var t = Domain.Entities.Tag.CreateGroupScoped(userId, sourceGroupId, "HauptgerichtX");
            db.Tags.Add(t);
            await db.SaveChangesAsync();
            customTagId = t.Id;
        }

        var globalTagIds = await GetSeededTagIdsAsync(1);
        var allTagIds = globalTagIds.Concat(new[] { customTagId }).ToArray();
        var createRes = await _client.PostAsJsonAsync(
            $"/api/groups/{sourceGroupId}/recipes",
            BuildCreateRequest("WithCustom", allTagIds));
        var original = (await createRes.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;
        Assert.Equal(2, original.Tags.Length);

        var forkRes = await _client.PostAsJsonAsync(
            $"/api/recipes/{original.Id}/fork",
            new { targetGroupId });
        Assert.Equal(HttpStatusCode.Created, forkRes.StatusCode);
        var forked = (await forkRes.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;
        // Global tag preserved; source-scoped custom tag dropped because
        // target has no matching (Name, Category).
        Assert.Single(forked.Tags);
        Assert.Equal(globalTagIds[0], forked.Tags[0].Id);
    }

    [Fact]
    public async Task Fork_Matches_Group_Scoped_Tag_By_Name_And_Category_In_Target()
    {
        var (userId, token) = await SignupAndLoginAsync("fork-tag-match@ex.com", "M");
        AuthorizeClient(_client, token);
        var sourceGroupId = await CreateGroupAsync(_client, "SourceMatch");
        var targetGroupId = await CreateGroupAsync(_client, "TargetMatch");

        // Create identically-named custom tags in BOTH groups (same name +
        // category). The fork should wire up the target's tag id, not
        // reuse the source's id.
        Guid sourceTagId;
        Guid targetTagId;
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var s = Domain.Entities.Tag.CreateGroupScoped(userId, sourceGroupId, "Lieblingsgericht");
            var t = Domain.Entities.Tag.CreateGroupScoped(userId, targetGroupId, "Lieblingsgericht");
            db.Tags.Add(s);
            db.Tags.Add(t);
            await db.SaveChangesAsync();
            sourceTagId = s.Id;
            targetTagId = t.Id;
        }

        var createRes = await _client.PostAsJsonAsync(
            $"/api/groups/{sourceGroupId}/recipes",
            BuildCreateRequest("LiebMatch", new[] { sourceTagId }));
        var original = (await createRes.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;

        var forkRes = await _client.PostAsJsonAsync(
            $"/api/recipes/{original.Id}/fork",
            new { targetGroupId });
        Assert.Equal(HttpStatusCode.Created, forkRes.StatusCode);
        var forked = (await forkRes.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;
        Assert.Single(forked.Tags);
        Assert.Equal(targetTagId, forked.Tags[0].Id);
        Assert.NotEqual(sourceTagId, forked.Tags[0].Id);
    }

    [Fact]
    public async Task Fork_Copies_Photo_Path_References_Sharing_Underlying_Files()
    {
        var (_, token) = await SignupAndLoginAsync("fork-photo@ex.com", "P");
        AuthorizeClient(_client, token);
        var sourceGroupId = await CreateGroupAsync(_client, "SourcePh");
        var targetGroupId = await CreateGroupAsync(_client, "TargetPh");

        var createRes = await _client.PostAsJsonAsync(
            $"/api/groups/{sourceGroupId}/recipes",
            BuildCreateRequest("WithPhoto"));
        var original = (await createRes.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;

        using (var form = new MultipartFormDataContent())
        {
            var bytes = new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 };
            var fileContent = new ByteArrayContent(bytes);
            fileContent.Headers.ContentType = new MediaTypeHeaderValue("image/png");
            form.Add(fileContent, "file", "test.png");
            var photoRes = await _client.PostAsync($"/api/recipes/{original.Id}/photos", form);
            Assert.Equal(HttpStatusCode.OK, photoRes.StatusCode);
        }

        var detailAfterPhoto = await _client.GetAsync($"/api/recipes/{original.Id}");
        var originalWithPhoto = (await detailAfterPhoto.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;
        Assert.Single(originalWithPhoto.Photos);

        var forkRes = await _client.PostAsJsonAsync(
            $"/api/recipes/{original.Id}/fork",
            new { targetGroupId });
        Assert.Equal(HttpStatusCode.Created, forkRes.StatusCode);
        var forked = (await forkRes.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;
        Assert.Single(forked.Photos);

        // Underlying stored path is the same in both recipes (shared reference
        // policy per S5 Deviations); signed URLs both point to that path.
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var origRow = await db.Recipes.AsNoTracking().SingleAsync(r => r.Id == original.Id);
        var forkedRow = await db.Recipes.AsNoTracking().SingleAsync(r => r.Id == forked.Id);
        Assert.Single(origRow.Photos);
        Assert.Single(forkedRow.Photos);
        Assert.Equal(origRow.Photos[0], forkedRow.Photos[0]);
    }

    [Fact]
    public async Task Fork_Unauthenticated_Returns_401()
    {
        var response = await _client.PostAsJsonAsync(
            $"/api/recipes/{Guid.NewGuid()}/fork",
            new { targetGroupId = Guid.NewGuid() });
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Fork_Nonexistent_Recipe_Returns_404()
    {
        var (_, token) = await SignupAndLoginAsync("fork-404@ex.com", "N");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client, "Any");

        var response = await _client.PostAsJsonAsync(
            $"/api/recipes/{Guid.NewGuid()}/fork",
            new { targetGroupId = groupId });
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    // ── POST /api/recipes/{id}/cook (DS5 "Jetzt gekocht") ───────────────

    [Fact]
    public async Task MarkCooked_Sets_LastCookedAt_And_Returns_Updated_Detail()
    {
        var (_, token) = await SignupAndLoginAsync("cook@ex.com", "C");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var createRes = await _client.PostAsJsonAsync(
            $"/api/groups/{groupId}/recipes", BuildCreateRequest("Gekocht"));
        var created = (await createRes.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;
        Assert.Null(created.LastCookedAt);

        // FakeTimeProvider is the authoritative clock — bump it by a few
        // seconds so the "cooked at" stamp is provably in the future of
        // the recipe's creation timestamp and we can assert exact equality
        // instead of a slippery wall-clock window. Kept under the JWT
        // access-token lifetime (15 min) so the token in this test client
        // stays valid.
        _factory.Clock.Advance(TimeSpan.FromSeconds(10));
        var expectedCookedAt = _factory.Clock.GetUtcNow();

        var response = await _client.PostAsync($"/api/recipes/{created.Id}/cook", content: null);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = (await response.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;
        Assert.NotNull(body.LastCookedAt);
        Assert.Equal(expectedCookedAt, body.LastCookedAt!.Value);

        // Persisted.
        var fetch = await _client.GetFromJsonAsync<RecipeEndpoints.RecipeDetailDto>(
            $"/api/recipes/{created.Id}");
        Assert.NotNull(fetch!.LastCookedAt);
        Assert.Equal(expectedCookedAt, fetch.LastCookedAt!.Value);
    }

    [Fact]
    public async Task MarkCooked_Returns_403_For_Non_Member()
    {
        var (_, aTok) = await SignupAndLoginAsync("cook-a@ex.com", "A");
        var (_, bTok) = await SignupAndLoginAsync("cook-b@ex.com", "B");
        using var clientA = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientA, aTok);
        var groupId = await CreateGroupAsync(clientA);
        var createRes = await clientA.PostAsJsonAsync(
            $"/api/groups/{groupId}/recipes", BuildCreateRequest());
        var created = (await createRes.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;

        using var clientB = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientB, bTok);
        var response = await clientB.PostAsync($"/api/recipes/{created.Id}/cook", content: null);
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task MarkCooked_Returns_404_For_Unknown_Recipe()
    {
        var (_, token) = await SignupAndLoginAsync("cook-nf@ex.com", "NF");
        AuthorizeClient(_client, token);

        var response = await _client.PostAsync($"/api/recipes/{Guid.NewGuid()}/cook", content: null);
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task MarkCooked_Returns_401_When_Unauthenticated()
    {
        var response = await _client.PostAsync($"/api/recipes/{Guid.NewGuid()}/cook", content: null);
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task MarkCooked_Does_Not_Append_Revision()
    {
        // Cooking a recipe is an activity signal, not an edit — we don't
        // want every "gekocht" tap to bloat the history panel. The revision
        // count must be unchanged after the call.
        var (_, token) = await SignupAndLoginAsync("cook-rev@ex.com", "R");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var createRes = await _client.PostAsJsonAsync(
            $"/api/groups/{groupId}/recipes", BuildCreateRequest("Kochn"));
        var created = (await createRes.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;

        var beforeRevs = await _client.GetFromJsonAsync<RecipeRevisionEndpoints.RevisionSummaryDto[]>(
            $"/api/recipes/{created.Id}/revisions");

        var response = await _client.PostAsync($"/api/recipes/{created.Id}/cook", content: null);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var afterRevs = await _client.GetFromJsonAsync<RecipeRevisionEndpoints.RevisionSummaryDto[]>(
            $"/api/recipes/{created.Id}/revisions");
        Assert.Equal(beforeRevs!.Length, afterRevs!.Length);
    }

    // ── test helpers ────────────────────────────────────────────────

    /// <summary>
    /// Polls <paramref name="predicate"/> every 50ms up to
    /// <paramref name="timeout"/>. Returns immediately once true;
    /// throws <see cref="Xunit.Sdk.XunitException"/> on timeout.
    /// Used to synchronize with fire-and-forget background work
    /// (e.g. the PF1 staged-blob delete after promote) that races the
    /// HTTP response on slower CI runners.
    /// </summary>
    private static async Task PollUntilAsync(
        Func<bool> predicate,
        TimeSpan timeout,
        string description)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            if (predicate())
            {
                return;
            }
            await Task.Delay(50);
        }

        if (predicate())
        {
            return;
        }

        throw new Xunit.Sdk.XunitException(
            $"Timed out waiting for {description} (waited {timeout})");
    }

    // ── OFF3 ETag + If-Match ─────────────────────────────────────────

    [Fact]
    public async Task GET_Recipe_Returns_ETag_Header_With_Version_Zero()
    {
        var (_, token) = await SignupAndLoginAsync("etag-recipe@ex.com", "E");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var created = await _client.PostAsJsonAsync(
            $"/api/groups/{groupId}/recipes", BuildCreateRequest("ETag-Rezept"));
        created.EnsureSuccessStatusCode();
        var dto = (await created.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;

        var res = await _client.GetAsync($"/api/recipes/{dto.Id}");

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.True(res.Headers.Contains("ETag"));
        var etag = res.Headers.GetValues("ETag").Single();
        Assert.Equal($"W/\"{dto.Id:D}-0\"", etag);
    }

    [Fact]
    public async Task PUT_Recipe_With_Correct_IfMatch_Succeeds_And_Bumps_Version()
    {
        var (_, token) = await SignupAndLoginAsync("ifmatch-ok@ex.com", "E");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var created = await _client.PostAsJsonAsync(
            $"/api/groups/{groupId}/recipes", BuildCreateRequest("Org"));
        var dto = (await created.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;

        var update = new RecipeEndpoints.UpdateRecipeRequest(
            Title: "Geändert",
            Description: dto.Description,
            DefaultServings: dto.DefaultServings,
            PrepTimeMinutes: dto.PrepTimeMinutes,
            Difficulty: dto.Difficulty,
            SourceUrl: dto.SourceUrl,
            Ingredients: Array.Empty<RecipeEndpoints.IngredientRequest>(),
            Steps: Array.Empty<RecipeEndpoints.StepRequest>(),
            TagIds: Array.Empty<Guid>());
        using var req = new HttpRequestMessage(HttpMethod.Put, $"/api/recipes/{dto.Id}")
        {
            Content = JsonContent.Create(update),
        };
        req.Headers.TryAddWithoutValidation("If-Match", $"W/\"{dto.Id:D}-{dto.Version}\"");
        var res = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var updated = (await res.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;
        Assert.Equal(dto.Version + 1, updated.Version);
        Assert.True(res.Headers.Contains("ETag"));
    }

    [Fact]
    public async Task PUT_Recipe_With_Stale_IfMatch_Returns_409_With_Current_Dto()
    {
        var (_, token) = await SignupAndLoginAsync("ifmatch-stale-r@ex.com", "E");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var created = await _client.PostAsJsonAsync(
            $"/api/groups/{groupId}/recipes", BuildCreateRequest("Erst"));
        var dto = (await created.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;
        var staleVersion = dto.Version; // 0

        // Move the server forward with a no-If-Match PUT.
        var intermediate = new RecipeEndpoints.UpdateRecipeRequest(
            Title: "Zwischenstand",
            Description: null,
            DefaultServings: 2,
            PrepTimeMinutes: null,
            Difficulty: 1,
            SourceUrl: null,
            Ingredients: Array.Empty<RecipeEndpoints.IngredientRequest>(),
            Steps: Array.Empty<RecipeEndpoints.StepRequest>(),
            TagIds: Array.Empty<Guid>());
        var firstPut = await _client.PutAsJsonAsync($"/api/recipes/{dto.Id}", intermediate);
        firstPut.EnsureSuccessStatusCode();

        // Attempt second PUT with the stale (original) ETag.
        var second = intermediate with { Title = "Zweit" };
        using var req = new HttpRequestMessage(HttpMethod.Put, $"/api/recipes/{dto.Id}")
        {
            Content = JsonContent.Create(second),
        };
        req.Headers.TryAddWithoutValidation("If-Match", $"W/\"{dto.Id:D}-{staleVersion}\"");
        var res = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
        var body = await res.Content.ReadFromJsonAsync<ConflictBodyDto>();
        Assert.NotNull(body);
        Assert.Equal("version_mismatch", body!.Code);
        Assert.NotNull(body.Current);
        Assert.Equal(staleVersion + 1, body.Current!.Value.GetProperty("version").GetInt32());
    }

    [Fact]
    public async Task PUT_Recipe_Without_IfMatch_Succeeds_For_Backcompat()
    {
        var (_, token) = await SignupAndLoginAsync("ifmatch-none-r@ex.com", "E");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var created = await _client.PostAsJsonAsync(
            $"/api/groups/{groupId}/recipes", BuildCreateRequest("ohne-ifmatch"));
        var dto = (await created.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;

        var update = new RecipeEndpoints.UpdateRecipeRequest(
            Title: "ohne-ifmatch-neu",
            Description: null,
            DefaultServings: 2,
            PrepTimeMinutes: null,
            Difficulty: 1,
            SourceUrl: null,
            Ingredients: Array.Empty<RecipeEndpoints.IngredientRequest>(),
            Steps: Array.Empty<RecipeEndpoints.StepRequest>(),
            TagIds: Array.Empty<Guid>());
        var res = await _client.PutAsJsonAsync($"/api/recipes/{dto.Id}", update);

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
    }

    [Fact]
    public async Task GET_After_Multiple_PUTs_Has_Incrementing_Version_In_ETag()
    {
        var (_, token) = await SignupAndLoginAsync("mult-r@ex.com", "E");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var created = await _client.PostAsJsonAsync(
            $"/api/groups/{groupId}/recipes", BuildCreateRequest("Mehrfach"));
        var dto = (await created.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;

        var update = new RecipeEndpoints.UpdateRecipeRequest(
            Title: "A", Description: null, DefaultServings: 2,
            PrepTimeMinutes: null, Difficulty: 1, SourceUrl: null,
            Ingredients: Array.Empty<RecipeEndpoints.IngredientRequest>(),
            Steps: Array.Empty<RecipeEndpoints.StepRequest>(),
            TagIds: Array.Empty<Guid>());
        (await _client.PutAsJsonAsync($"/api/recipes/{dto.Id}", update)).EnsureSuccessStatusCode();
        (await _client.PutAsJsonAsync($"/api/recipes/{dto.Id}", update with { Title = "B" })).EnsureSuccessStatusCode();

        var res = await _client.GetAsync($"/api/recipes/{dto.Id}");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal($"W/\"{dto.Id:D}-2\"", res.Headers.GetValues("ETag").Single());
    }

    private sealed record ConflictBodyDto(string Code, string Message, System.Text.Json.JsonElement? Current);
}
