using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using FamilienKochbuch.Api.Endpoints;
using FamilienKochbuch.Api.Endpoints.MealPlanning;
using FamilienKochbuch.Api.Tests.Infrastructure;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.Enums;
using FamilienKochbuch.Domain.MealPlanning;
using FamilienKochbuch.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace FamilienKochbuch.Api.Tests.Endpoints.MealPlanning;

/// <summary>
/// End-to-end tests for the P3-1 meal plan CRUD endpoints. Signs real
/// users in via /api/auth so JWT + group-membership RBAC is exercised
/// against the real pipeline; SQLite in-memory backs the DbContext.
///
/// Covers all six endpoints' happy paths plus the failure cases called
/// out in the plan: Monday validation, cross-plan parent guard,
/// servings bounds, idempotent create, delete-detaches-children,
/// copy-from ParentSlotId remap.
/// </summary>
public class MealPlanEndpointsTests : IClassFixture<FamilienKochbuchWebApplicationFactory>, IAsyncLifetime
{
    // Monday 2026-04-20 is the canonical "current week" for these
    // tests; Monday 2026-04-13 is the "previous week" used for
    // copy-from.
    private static readonly DateOnly CurrentMonday = new(2026, 4, 20);
    private static readonly DateOnly PreviousMonday = new(2026, 4, 13);
    private static readonly DateOnly Tuesday = new(2026, 4, 21);

    private readonly FamilienKochbuchWebApplicationFactory _factory;
    private HttpClient _client = null!;

    public MealPlanEndpointsTests(FamilienKochbuchWebApplicationFactory factory)
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
        db.MealPlanSlots.RemoveRange(db.MealPlanSlots);
        db.MealPlans.RemoveRange(db.MealPlans);
        db.RecipeTags.RemoveRange(db.RecipeTags);
        db.Ingredients.RemoveRange(db.Ingredients);
        db.RecipeSteps.RemoveRange(db.RecipeSteps);
        db.StagedPhotos.RemoveRange(db.StagedPhotos);
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
    }

    // ── Helpers ──────────────────────────────────────────────────────

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

    private async Task<Guid> SeedRecipeAsync(Guid groupId, Guid creatorUserId, string title = "Linsen-Curry")
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var recipe = new Recipe(
            groupId: groupId,
            createdByUserId: creatorUserId,
            title: title,
            description: null,
            defaultServings: 2,
            prepTimeMinutes: 30,
            difficulty: 1,
            sourceUrl: null,
            sourceType: RecipeSourceType.Manual,
            forkOfRecipeId: null,
            createdAt: DateTimeOffset.UtcNow);
        db.Recipes.Add(recipe);
        await db.SaveChangesAsync();
        return recipe.Id;
    }

    private async Task<MealPlanEndpoints.MealPlanDto> CreatePlanAsync(HttpClient client, Guid groupId, DateOnly weekStart)
    {
        var res = await client.PostAsJsonAsync(
            $"/api/groups/{groupId}/mealplans",
            new MealPlanEndpoints.CreateMealPlanRequest(weekStart));
        Assert.Equal(HttpStatusCode.Created, res.StatusCode);
        return (await res.Content.ReadFromJsonAsync<MealPlanEndpoints.MealPlanDto>())!;
    }

    // ── GET /api/groups/{groupId}/mealplans/{weekStart} ──────────────

    [Fact]
    public async Task Get_Returns_200_With_Plan_And_Slots()
    {
        var (userId, token) = await SignupAndLoginAsync("get200@ex.com", "G");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId);
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);
        await _client.PostAsJsonAsync($"/api/mealplans/{plan.Id}/slots",
            new MealPlanEndpoints.AddSlotRequest(
                RecipeId: recipeId, Label: null, Date: CurrentMonday,
                Meal: MealSlot.Mittag, Servings: 2));

        var res = await _client.GetAsync(
            $"/api/groups/{groupId}/mealplans/{CurrentMonday:yyyy-MM-dd}");

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var body = (await res.Content.ReadFromJsonAsync<MealPlanEndpoints.MealPlanDto>())!;
        Assert.Equal(plan.Id, body.Id);
        Assert.Single(body.Slots);
        Assert.Equal(recipeId, body.Slots[0].RecipeId);
    }

    [Fact]
    public async Task Get_Returns_404_When_No_Plan_Exists()
    {
        var (_, token) = await SignupAndLoginAsync("get404@ex.com", "G");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);

        var res = await _client.GetAsync(
            $"/api/groups/{groupId}/mealplans/{CurrentMonday:yyyy-MM-dd}");

        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }

    [Fact]
    public async Task Get_Returns_403_For_Non_Member()
    {
        var (_, aTok) = await SignupAndLoginAsync("member@ex.com", "M");
        var (_, bTok) = await SignupAndLoginAsync("outsider@ex.com", "O");
        using var a = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(a, aTok);
        var groupId = await CreateGroupAsync(a);
        await CreatePlanAsync(a, groupId, CurrentMonday);

        using var b = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(b, bTok);
        var res = await b.GetAsync(
            $"/api/groups/{groupId}/mealplans/{CurrentMonday:yyyy-MM-dd}");

        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
    }

    [Fact]
    public async Task Get_Returns_400_For_Non_Monday_WeekStart()
    {
        var (_, token) = await SignupAndLoginAsync("nonmon@ex.com", "N");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);

        var res = await _client.GetAsync(
            $"/api/groups/{groupId}/mealplans/{Tuesday:yyyy-MM-dd}");

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    [Fact]
    public async Task Get_Returns_400_For_Bad_Date_Format()
    {
        var (_, token) = await SignupAndLoginAsync("badfmt@ex.com", "B");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);

        var res = await _client.GetAsync($"/api/groups/{groupId}/mealplans/not-a-date");

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    [Fact]
    public async Task Get_Returns_401_When_Unauthenticated()
    {
        var groupId = Guid.NewGuid();
        var res = await _client.GetAsync(
            $"/api/groups/{groupId}/mealplans/{CurrentMonday:yyyy-MM-dd}");
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
    }

    // ── POST /api/groups/{groupId}/mealplans ─────────────────────────

    [Fact]
    public async Task Create_Plan_Returns_201_With_Empty_Slots()
    {
        var (_, token) = await SignupAndLoginAsync("create@ex.com", "C");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);

        var res = await _client.PostAsJsonAsync(
            $"/api/groups/{groupId}/mealplans",
            new MealPlanEndpoints.CreateMealPlanRequest(CurrentMonday));

        Assert.Equal(HttpStatusCode.Created, res.StatusCode);
        var body = (await res.Content.ReadFromJsonAsync<MealPlanEndpoints.MealPlanDto>())!;
        Assert.Equal(groupId, body.GroupId);
        Assert.Equal(CurrentMonday, body.WeekStart);
        Assert.Empty(body.Slots);
    }

    [Fact]
    public async Task Create_Plan_Is_Idempotent_For_Same_Week()
    {
        var (_, token) = await SignupAndLoginAsync("idemp@ex.com", "I");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var first = await CreatePlanAsync(_client, groupId, CurrentMonday);

        var second = await _client.PostAsJsonAsync(
            $"/api/groups/{groupId}/mealplans",
            new MealPlanEndpoints.CreateMealPlanRequest(CurrentMonday));

        Assert.Equal(HttpStatusCode.OK, second.StatusCode);
        var body = (await second.Content.ReadFromJsonAsync<MealPlanEndpoints.MealPlanDto>())!;
        Assert.Equal(first.Id, body.Id);
    }

    [Fact]
    public async Task Create_Plan_Rejects_Non_Monday()
    {
        var (_, token) = await SignupAndLoginAsync("notmon@ex.com", "N");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);

        var res = await _client.PostAsJsonAsync(
            $"/api/groups/{groupId}/mealplans",
            new MealPlanEndpoints.CreateMealPlanRequest(Tuesday));

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    [Fact]
    public async Task Create_Plan_Returns_403_For_Non_Member()
    {
        var (_, aTok) = await SignupAndLoginAsync("ca@ex.com", "A");
        var (_, bTok) = await SignupAndLoginAsync("cb@ex.com", "B");
        using var a = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(a, aTok);
        var groupId = await CreateGroupAsync(a);

        using var b = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(b, bTok);
        var res = await b.PostAsJsonAsync(
            $"/api/groups/{groupId}/mealplans",
            new MealPlanEndpoints.CreateMealPlanRequest(CurrentMonday));

        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
    }

    [Fact]
    public async Task Create_Plan_Returns_404_When_Group_Missing()
    {
        var (_, token) = await SignupAndLoginAsync("nogrp@ex.com", "G");
        AuthorizeClient(_client, token);
        var res = await _client.PostAsJsonAsync(
            $"/api/groups/{Guid.NewGuid()}/mealplans",
            new MealPlanEndpoints.CreateMealPlanRequest(CurrentMonday));
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }

    // ── POST /api/mealplans/{planId}/slots ───────────────────────────

    [Fact]
    public async Task AddSlot_Creates_Slot_With_Recipe()
    {
        var (userId, token) = await SignupAndLoginAsync("add@ex.com", "A");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId);
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);

        var res = await _client.PostAsJsonAsync(
            $"/api/mealplans/{plan.Id}/slots",
            new MealPlanEndpoints.AddSlotRequest(
                RecipeId: recipeId, Label: null, Date: CurrentMonday,
                Meal: MealSlot.Abend, Servings: 3));

        Assert.Equal(HttpStatusCode.Created, res.StatusCode);
        var body = (await res.Content.ReadFromJsonAsync<MealPlanEndpoints.MealPlanSlotDto>())!;
        Assert.Equal(recipeId, body.RecipeId);
        Assert.Equal(3, body.Servings);
        Assert.Equal(MealSlot.Abend, body.Meal);
        Assert.False(body.IsCooked);
    }

    [Fact]
    public async Task AddSlot_Rejects_Servings_Zero()
    {
        var (userId, token) = await SignupAndLoginAsync("zero@ex.com", "Z");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId);
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);

        var res = await _client.PostAsJsonAsync(
            $"/api/mealplans/{plan.Id}/slots",
            new MealPlanEndpoints.AddSlotRequest(
                RecipeId: recipeId, Label: null, Date: CurrentMonday,
                Meal: MealSlot.Mittag, Servings: 0));

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    [Fact]
    public async Task AddSlot_Rejects_Date_Outside_Week()
    {
        var (userId, token) = await SignupAndLoginAsync("outside@ex.com", "O");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId);
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);

        var res = await _client.PostAsJsonAsync(
            $"/api/mealplans/{plan.Id}/slots",
            new MealPlanEndpoints.AddSlotRequest(
                RecipeId: recipeId, Label: null, Date: CurrentMonday.AddDays(14),
                Meal: MealSlot.Mittag, Servings: 2));

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    [Fact]
    public async Task AddSlot_Rejects_Recipe_From_Other_Group()
    {
        var (userA, aTok) = await SignupAndLoginAsync("ga@ex.com", "A");
        var (userB, bTok) = await SignupAndLoginAsync("gb@ex.com", "B");
        using var a = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(a, aTok);
        var groupAId = await CreateGroupAsync(a, "A-Group");
        var recipeInA = await SeedRecipeAsync(groupAId, userA);

        using var b = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(b, bTok);
        var groupBId = await CreateGroupAsync(b, "B-Group");
        var planB = await CreatePlanAsync(b, groupBId, CurrentMonday);

        var res = await b.PostAsJsonAsync(
            $"/api/mealplans/{planB.Id}/slots",
            new MealPlanEndpoints.AddSlotRequest(
                RecipeId: recipeInA, Label: null, Date: CurrentMonday,
                Meal: MealSlot.Mittag, Servings: 2));

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    [Fact]
    public async Task AddSlot_Rejects_ParentSlot_In_Different_Plan()
    {
        var (userId, token) = await SignupAndLoginAsync("xplan@ex.com", "X");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId);
        var planCurrent = await CreatePlanAsync(_client, groupId, CurrentMonday);
        var planPrev = await CreatePlanAsync(_client, groupId, PreviousMonday);

        // parent in prev plan
        var parentRes = await _client.PostAsJsonAsync(
            $"/api/mealplans/{planPrev.Id}/slots",
            new MealPlanEndpoints.AddSlotRequest(
                RecipeId: recipeId, Label: null, Date: PreviousMonday,
                Meal: MealSlot.Mittag, Servings: 4));
        var parent = (await parentRes.Content.ReadFromJsonAsync<MealPlanEndpoints.MealPlanSlotDto>())!;

        var res = await _client.PostAsJsonAsync(
            $"/api/mealplans/{planCurrent.Id}/slots",
            new MealPlanEndpoints.AddSlotRequest(
                RecipeId: recipeId, Label: null, Date: CurrentMonday,
                Meal: MealSlot.Mittag, Servings: 1, SortOrder: null,
                ParentSlotId: parent.Id));

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    [Fact]
    public async Task AddSlot_Returns_403_For_Non_Member()
    {
        var (userA, aTok) = await SignupAndLoginAsync("aa@ex.com", "A");
        var (_, bTok) = await SignupAndLoginAsync("bb@ex.com", "B");
        using var a = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(a, aTok);
        var groupId = await CreateGroupAsync(a);
        var recipeId = await SeedRecipeAsync(groupId, userA);
        var plan = await CreatePlanAsync(a, groupId, CurrentMonday);

        using var b = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(b, bTok);
        var res = await b.PostAsJsonAsync(
            $"/api/mealplans/{plan.Id}/slots",
            new MealPlanEndpoints.AddSlotRequest(
                RecipeId: recipeId, Label: null, Date: CurrentMonday,
                Meal: MealSlot.Mittag, Servings: 2));

        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
    }

    [Fact]
    public async Task AddSlot_Auto_Assigns_Next_SortOrder()
    {
        var (userId, token) = await SignupAndLoginAsync("sort@ex.com", "S");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId);
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);

        var first = await _client.PostAsJsonAsync(
            $"/api/mealplans/{plan.Id}/slots",
            new MealPlanEndpoints.AddSlotRequest(recipeId, null, CurrentMonday, MealSlot.Mittag, 2));
        var firstBody = (await first.Content.ReadFromJsonAsync<MealPlanEndpoints.MealPlanSlotDto>())!;

        var second = await _client.PostAsJsonAsync(
            $"/api/mealplans/{plan.Id}/slots",
            new MealPlanEndpoints.AddSlotRequest(recipeId, null, CurrentMonday, MealSlot.Mittag, 2));
        var secondBody = (await second.Content.ReadFromJsonAsync<MealPlanEndpoints.MealPlanSlotDto>())!;

        Assert.Equal(0, firstBody.SortOrder);
        Assert.Equal(1, secondBody.SortOrder);
    }

    // ── PATCH /api/mealplans/{planId}/slots/{slotId} ─────────────────

    [Fact]
    public async Task PatchSlot_Partial_Update_Leaves_Absent_Fields_Untouched()
    {
        var (userId, token) = await SignupAndLoginAsync("patch@ex.com", "P");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId);
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);
        var slot = await AddHappySlotAsync(plan.Id, recipeId, CurrentMonday, MealSlot.Mittag, 2, "Hauptgericht");

        // Update servings ONLY; label should stay "Hauptgericht".
        var patch = new StringContent(
            """{"servings": 5}""",
            Encoding.UTF8, "application/json");
        var res = await _client.PatchAsync($"/api/mealplans/{plan.Id}/slots/{slot.Id}", patch);

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var body = (await res.Content.ReadFromJsonAsync<MealPlanEndpoints.MealPlanSlotDto>())!;
        Assert.Equal(5, body.Servings);
        Assert.Equal("Hauptgericht", body.Label);
        Assert.Equal(recipeId, body.RecipeId);
    }

    [Fact]
    public async Task PatchSlot_Null_Clears_Label_When_Recipe_Present()
    {
        var (userId, token) = await SignupAndLoginAsync("clr@ex.com", "C");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId);
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);
        var slot = await AddHappySlotAsync(plan.Id, recipeId, CurrentMonday, MealSlot.Mittag, 2, "Hauptgericht");

        var res = await _client.PatchAsync(
            $"/api/mealplans/{plan.Id}/slots/{slot.Id}",
            new StringContent("""{"label": null}""", Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var body = (await res.Content.ReadFromJsonAsync<MealPlanEndpoints.MealPlanSlotDto>())!;
        Assert.Null(body.Label);
    }

    [Fact]
    public async Task PatchSlot_Null_Label_Rejected_When_No_Recipe()
    {
        var (_, token) = await SignupAndLoginAsync("nobase@ex.com", "N");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);
        // Create with label-only (recipeId null)
        var slot = await AddHappySlotAsync(plan.Id, null, CurrentMonday, MealSlot.Abend, 2, "Restaurant");

        // Clearing label while recipe is also null must fail.
        var res = await _client.PatchAsync(
            $"/api/mealplans/{plan.Id}/slots/{slot.Id}",
            new StringContent("""{"label": null}""", Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    [Fact]
    public async Task PatchSlot_Sets_IsCooked()
    {
        var (userId, token) = await SignupAndLoginAsync("cooked@ex.com", "K");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId);
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);
        var slot = await AddHappySlotAsync(plan.Id, recipeId, CurrentMonday, MealSlot.Mittag, 2, null);

        var res = await _client.PatchAsync(
            $"/api/mealplans/{plan.Id}/slots/{slot.Id}",
            new StringContent("""{"isCooked": true}""", Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var body = (await res.Content.ReadFromJsonAsync<MealPlanEndpoints.MealPlanSlotDto>())!;
        Assert.True(body.IsCooked);
    }

    [Fact]
    public async Task PatchSlot_Rejects_Cross_Plan_Parent()
    {
        var (userId, token) = await SignupAndLoginAsync("xpp@ex.com", "X");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId);
        var planCurrent = await CreatePlanAsync(_client, groupId, CurrentMonday);
        var planPrev = await CreatePlanAsync(_client, groupId, PreviousMonday);
        var parent = await AddHappySlotAsync(planPrev.Id, recipeId, PreviousMonday, MealSlot.Mittag, 4, null);
        var child = await AddHappySlotAsync(planCurrent.Id, recipeId, CurrentMonday, MealSlot.Mittag, 1, null);

        var res = await _client.PatchAsync(
            $"/api/mealplans/{planCurrent.Id}/slots/{child.Id}",
            new StringContent($$"""{"parentSlotId": "{{parent.Id}}"}""", Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    [Fact]
    public async Task PatchSlot_Accepts_Parent_Within_Same_Plan()
    {
        var (userId, token) = await SignupAndLoginAsync("samep@ex.com", "S");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId);
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);
        var parent = await AddHappySlotAsync(plan.Id, recipeId, CurrentMonday, MealSlot.Mittag, 5, "Meal Prep");
        var child = await AddHappySlotAsync(plan.Id, recipeId, CurrentMonday.AddDays(1), MealSlot.Mittag, 1, null);

        var res = await _client.PatchAsync(
            $"/api/mealplans/{plan.Id}/slots/{child.Id}",
            new StringContent($$"""{"parentSlotId": "{{parent.Id}}"}""", Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var body = (await res.Content.ReadFromJsonAsync<MealPlanEndpoints.MealPlanSlotDto>())!;
        Assert.Equal(parent.Id, body.ParentSlotId);
    }

    [Fact]
    public async Task PatchSlot_Null_ParentSlotId_Detaches()
    {
        var (userId, token) = await SignupAndLoginAsync("detach@ex.com", "D");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId);
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);
        var parent = await AddHappySlotAsync(plan.Id, recipeId, CurrentMonday, MealSlot.Mittag, 5, "Meal Prep");
        var child = await AddHappySlotAsync(plan.Id, recipeId, CurrentMonday.AddDays(1), MealSlot.Mittag, 1, null);
        await _client.PatchAsync(
            $"/api/mealplans/{plan.Id}/slots/{child.Id}",
            new StringContent($$"""{"parentSlotId": "{{parent.Id}}"}""", Encoding.UTF8, "application/json"));

        var res = await _client.PatchAsync(
            $"/api/mealplans/{plan.Id}/slots/{child.Id}",
            new StringContent("""{"parentSlotId": null}""", Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var body = (await res.Content.ReadFromJsonAsync<MealPlanEndpoints.MealPlanSlotDto>())!;
        Assert.Null(body.ParentSlotId);
    }

    [Fact]
    public async Task PatchSlot_Rejects_Two_Step_Cycle()
    {
        // Regression for the cycle-bypass found in the /security review:
        // a freshly-loaded candidate parent has its ParentSlot nav set
        // to null, so the in-memory CanSetParent guard couldn't see
        // ancestors and two PATCHes could build A↔B. Endpoint must
        // reject the second PATCH with `parent.cycle`.
        var (userId, token) = await SignupAndLoginAsync("cycle@ex.com", "C");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId);
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);
        var a = await AddHappySlotAsync(plan.Id, recipeId, CurrentMonday, MealSlot.Mittag, 2, "A");
        var b = await AddHappySlotAsync(plan.Id, recipeId, CurrentMonday.AddDays(1), MealSlot.Mittag, 2, "B");

        // Step 1: A → parent=B (OK, A has no ancestors).
        var step1 = await _client.PatchAsync(
            $"/api/mealplans/{plan.Id}/slots/{a.Id}",
            new StringContent($$"""{"parentSlotId": "{{b.Id}}"}""", Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.OK, step1.StatusCode);

        // Step 2: B → parent=A would form A→B→A. Must be rejected.
        var step2 = await _client.PatchAsync(
            $"/api/mealplans/{plan.Id}/slots/{b.Id}",
            new StringContent($$"""{"parentSlotId": "{{a.Id}}"}""", Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.BadRequest, step2.StatusCode);
        var err = await step2.Content.ReadFromJsonAsync<ErrorResponseDto>();
        Assert.Equal("parent.cycle", err!.Code);
    }

    private sealed record ErrorResponseDto(string Code, string Message);

    [Fact]
    public async Task PatchSlot_Rejects_Self_Parent_Cycle()
    {
        var (userId, token) = await SignupAndLoginAsync("self@ex.com", "S");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId);
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);
        var slot = await AddHappySlotAsync(plan.Id, recipeId, CurrentMonday, MealSlot.Mittag, 2, null);

        var res = await _client.PatchAsync(
            $"/api/mealplans/{plan.Id}/slots/{slot.Id}",
            new StringContent($$"""{"parentSlotId": "{{slot.Id}}"}""", Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    [Fact]
    public async Task PatchSlot_Returns_404_For_Unknown_Slot()
    {
        var (_, token) = await SignupAndLoginAsync("p404@ex.com", "P");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);

        var res = await _client.PatchAsync(
            $"/api/mealplans/{plan.Id}/slots/{Guid.NewGuid()}",
            new StringContent("""{"servings": 3}""", Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }

    [Fact]
    public async Task PatchSlot_Returns_400_When_Servings_Out_Of_Range()
    {
        var (userId, token) = await SignupAndLoginAsync("prange@ex.com", "R");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId);
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);
        var slot = await AddHappySlotAsync(plan.Id, recipeId, CurrentMonday, MealSlot.Mittag, 2, null);

        var res = await _client.PatchAsync(
            $"/api/mealplans/{plan.Id}/slots/{slot.Id}",
            new StringContent("""{"servings": 99}""", Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    [Fact]
    public async Task PatchSlot_Returns_403_For_Non_Member()
    {
        var (userA, aTok) = await SignupAndLoginAsync("pma@ex.com", "A");
        var (_, bTok) = await SignupAndLoginAsync("pmb@ex.com", "B");
        using var a = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(a, aTok);
        var groupId = await CreateGroupAsync(a);
        var recipeId = await SeedRecipeAsync(groupId, userA);
        var plan = await CreatePlanAsync(a, groupId, CurrentMonday);
        var slot = await AddHappySlotAsync(plan.Id, recipeId, CurrentMonday, MealSlot.Mittag, 2, null, a);

        using var b = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(b, bTok);
        var res = await b.PatchAsync(
            $"/api/mealplans/{plan.Id}/slots/{slot.Id}",
            new StringContent("""{"servings": 3}""", Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
    }

    [Fact]
    public async Task PatchSlot_Rejects_Recipe_From_Other_Group()
    {
        var (userA, aTok) = await SignupAndLoginAsync("rxga@ex.com", "A");
        var (userB, bTok) = await SignupAndLoginAsync("rxgb@ex.com", "B");
        using var a = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(a, aTok);
        var groupA = await CreateGroupAsync(a, "A");
        var recipeA = await SeedRecipeAsync(groupA, userA);

        using var b = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(b, bTok);
        var groupB = await CreateGroupAsync(b, "B");
        var recipeB = await SeedRecipeAsync(groupB, userB);
        var plan = await CreatePlanAsync(b, groupB, CurrentMonday);
        var slot = await AddHappySlotAsync(plan.Id, recipeB, CurrentMonday, MealSlot.Mittag, 2, null, b);

        var res = await b.PatchAsync(
            $"/api/mealplans/{plan.Id}/slots/{slot.Id}",
            new StringContent($$"""{"recipeId": "{{recipeA}}"}""", Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    // ── DELETE /api/mealplans/{planId}/slots/{slotId} ────────────────

    [Fact]
    public async Task DeleteSlot_Returns_NoContent()
    {
        var (userId, token) = await SignupAndLoginAsync("del@ex.com", "D");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId);
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);
        var slot = await AddHappySlotAsync(plan.Id, recipeId, CurrentMonday, MealSlot.Mittag, 2, null);

        var res = await _client.DeleteAsync($"/api/mealplans/{plan.Id}/slots/{slot.Id}");

        Assert.Equal(HttpStatusCode.NoContent, res.StatusCode);
    }

    [Fact]
    public async Task DeleteSlot_Returns_404_For_Unknown_Slot()
    {
        var (_, token) = await SignupAndLoginAsync("d404@ex.com", "D");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);

        var res = await _client.DeleteAsync($"/api/mealplans/{plan.Id}/slots/{Guid.NewGuid()}");

        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }

    [Fact]
    public async Task DeleteSlot_Nulls_Children_ParentSlotId()
    {
        var (userId, token) = await SignupAndLoginAsync("delparent@ex.com", "D");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId);
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);
        var parent = await AddHappySlotAsync(plan.Id, recipeId, CurrentMonday, MealSlot.Mittag, 5, "Meal Prep");
        var child = await AddHappySlotAsync(plan.Id, recipeId, CurrentMonday.AddDays(1), MealSlot.Mittag, 1, null);
        await _client.PatchAsync(
            $"/api/mealplans/{plan.Id}/slots/{child.Id}",
            new StringContent($$"""{"parentSlotId": "{{parent.Id}}"}""", Encoding.UTF8, "application/json"));

        var res = await _client.DeleteAsync($"/api/mealplans/{plan.Id}/slots/{parent.Id}");

        Assert.Equal(HttpStatusCode.NoContent, res.StatusCode);
        var get = await _client.GetAsync($"/api/groups/{groupId}/mealplans/{CurrentMonday:yyyy-MM-dd}");
        var body = (await get.Content.ReadFromJsonAsync<MealPlanEndpoints.MealPlanDto>())!;
        Assert.Single(body.Slots); // parent gone
        Assert.Null(body.Slots[0].ParentSlotId); // child's ref was cleared
    }

    [Fact]
    public async Task DeleteSlot_Returns_403_For_Non_Member()
    {
        var (userA, aTok) = await SignupAndLoginAsync("dma@ex.com", "A");
        var (_, bTok) = await SignupAndLoginAsync("dmb@ex.com", "B");
        using var a = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(a, aTok);
        var groupId = await CreateGroupAsync(a);
        var recipeId = await SeedRecipeAsync(groupId, userA);
        var plan = await CreatePlanAsync(a, groupId, CurrentMonday);
        var slot = await AddHappySlotAsync(plan.Id, recipeId, CurrentMonday, MealSlot.Mittag, 2, null, a);

        using var b = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(b, bTok);
        var res = await b.DeleteAsync($"/api/mealplans/{plan.Id}/slots/{slot.Id}");

        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
    }

    // ── POST /api/mealplans/{planId}/copy-from/{sourceWeekStart} ────

    [Fact]
    public async Task CopyFrom_Copies_Slots_To_Target_Plan()
    {
        var (userId, token) = await SignupAndLoginAsync("copy@ex.com", "C");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId);
        var source = await CreatePlanAsync(_client, groupId, PreviousMonday);
        await AddHappySlotAsync(source.Id, recipeId, PreviousMonday, MealSlot.Mittag, 2, "Hauptgericht");
        await AddHappySlotAsync(source.Id, recipeId, PreviousMonday.AddDays(1), MealSlot.Abend, 3, null);
        var target = await CreatePlanAsync(_client, groupId, CurrentMonday);

        var res = await _client.PostAsync(
            $"/api/mealplans/{target.Id}/copy-from/{PreviousMonday:yyyy-MM-dd}", null);

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var body = (await res.Content.ReadFromJsonAsync<MealPlanEndpoints.MealPlanDto>())!;
        Assert.Equal(2, body.Slots.Length);
        // Dates shifted to current week
        Assert.All(body.Slots, s => Assert.InRange(s.Date, CurrentMonday, CurrentMonday.AddDays(6)));
        // Reset IsCooked
        Assert.All(body.Slots, s => Assert.False(s.IsCooked));
    }

    [Fact]
    public async Task CopyFrom_Remaps_ParentSlotId_When_Both_Copied()
    {
        var (userId, token) = await SignupAndLoginAsync("remap@ex.com", "R");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId);
        var source = await CreatePlanAsync(_client, groupId, PreviousMonday);
        var parent = await AddHappySlotAsync(source.Id, recipeId, PreviousMonday, MealSlot.Mittag, 5, "Meal Prep");
        var child = await AddHappySlotAsync(source.Id, recipeId, PreviousMonday.AddDays(1), MealSlot.Mittag, 1, null);
        await _client.PatchAsync(
            $"/api/mealplans/{source.Id}/slots/{child.Id}",
            new StringContent($$"""{"parentSlotId": "{{parent.Id}}"}""", Encoding.UTF8, "application/json"));
        var target = await CreatePlanAsync(_client, groupId, CurrentMonday);

        var res = await _client.PostAsync(
            $"/api/mealplans/{target.Id}/copy-from/{PreviousMonday:yyyy-MM-dd}", null);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var body = (await res.Content.ReadFromJsonAsync<MealPlanEndpoints.MealPlanDto>())!;

        var newChild = body.Slots.Single(s => s.ParentSlotId is not null);
        var newParent = body.Slots.Single(s => s.ParentSlotId is null && s.Label == "Meal Prep");
        Assert.Equal(newParent.Id, newChild.ParentSlotId);
        // Ensure the remapped parent is in the target plan, not the source.
        Assert.NotEqual(parent.Id, newParent.Id);
        Assert.NotEqual(child.Id, newChild.Id);
    }

    [Fact]
    public async Task CopyFrom_Returns_404_For_Missing_Source()
    {
        var (_, token) = await SignupAndLoginAsync("cfnf@ex.com", "C");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var target = await CreatePlanAsync(_client, groupId, CurrentMonday);

        var res = await _client.PostAsync(
            $"/api/mealplans/{target.Id}/copy-from/{PreviousMonday:yyyy-MM-dd}", null);

        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }

    [Fact]
    public async Task CopyFrom_Rejects_Same_Plan()
    {
        var (userId, token) = await SignupAndLoginAsync("cfsame@ex.com", "S");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);

        var res = await _client.PostAsync(
            $"/api/mealplans/{plan.Id}/copy-from/{CurrentMonday:yyyy-MM-dd}", null);

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    [Fact]
    public async Task CopyFrom_Returns_400_For_Non_Monday_Source()
    {
        var (_, token) = await SignupAndLoginAsync("cfmon@ex.com", "M");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);

        var res = await _client.PostAsync(
            $"/api/mealplans/{plan.Id}/copy-from/{Tuesday:yyyy-MM-dd}", null);

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    [Fact]
    public async Task CopyFrom_Returns_403_For_Non_Member()
    {
        var (userA, aTok) = await SignupAndLoginAsync("cfma@ex.com", "A");
        var (_, bTok) = await SignupAndLoginAsync("cfmb@ex.com", "B");
        using var a = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(a, aTok);
        var groupId = await CreateGroupAsync(a);
        var recipeId = await SeedRecipeAsync(groupId, userA);
        var source = await CreatePlanAsync(a, groupId, PreviousMonday);
        await AddHappySlotAsync(source.Id, recipeId, PreviousMonday, MealSlot.Mittag, 2, null, a);
        var target = await CreatePlanAsync(a, groupId, CurrentMonday);

        using var b = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(b, bTok);
        var res = await b.PostAsync(
            $"/api/mealplans/{target.Id}/copy-from/{PreviousMonday:yyyy-MM-dd}", null);

        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
    }

    [Fact]
    public async Task CopyFrom_Resets_IsCooked_On_Copied_Slots()
    {
        var (userId, token) = await SignupAndLoginAsync("resetc@ex.com", "R");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId);
        var source = await CreatePlanAsync(_client, groupId, PreviousMonday);
        var srcSlot = await AddHappySlotAsync(source.Id, recipeId, PreviousMonday, MealSlot.Mittag, 2, null);
        await _client.PatchAsync(
            $"/api/mealplans/{source.Id}/slots/{srcSlot.Id}",
            new StringContent("""{"isCooked": true}""", Encoding.UTF8, "application/json"));
        var target = await CreatePlanAsync(_client, groupId, CurrentMonday);

        var res = await _client.PostAsync(
            $"/api/mealplans/{target.Id}/copy-from/{PreviousMonday:yyyy-MM-dd}", null);

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var body = (await res.Content.ReadFromJsonAsync<MealPlanEndpoints.MealPlanDto>())!;
        Assert.All(body.Slots, s => Assert.False(s.IsCooked));
    }

    // ── Version bump (P3-9 light-history) ───────────────────────────
    //
    // Every slot-level mutation must call MealPlan.BumpVersion() so the
    // plan's `Version` counter reflects exactly how many edits have
    // been applied since creation. Plan §P3-9 uses this counter for
    // optimistic concurrency + the light-history badge.

    [Fact]
    public async Task Create_Plan_Starts_Version_At_Zero()
    {
        var (_, token) = await SignupAndLoginAsync("v0@ex.com", "V");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);

        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);

        Assert.Equal(0, plan.Version);
    }

    [Fact]
    public async Task AddSlot_Increments_Plan_Version()
    {
        var (userId, token) = await SignupAndLoginAsync("vadd@ex.com", "V");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId);
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);

        await AddHappySlotAsync(plan.Id, recipeId, CurrentMonday, MealSlot.Mittag, 2, null);

        var fetched = await FetchPlanAsync(_client, groupId, CurrentMonday);
        Assert.Equal(1, fetched.Version);
    }

    [Fact]
    public async Task PatchSlot_Increments_Plan_Version()
    {
        var (userId, token) = await SignupAndLoginAsync("vpatch@ex.com", "V");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId);
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);
        var slot = await AddHappySlotAsync(plan.Id, recipeId, CurrentMonday, MealSlot.Mittag, 2, null);
        var afterAdd = await FetchPlanAsync(_client, groupId, CurrentMonday);
        Assert.Equal(1, afterAdd.Version);

        var res = await _client.PatchAsync(
            $"/api/mealplans/{plan.Id}/slots/{slot.Id}",
            new StringContent("""{"servings": 4}""", Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);

        var afterPatch = await FetchPlanAsync(_client, groupId, CurrentMonday);
        Assert.Equal(2, afterPatch.Version);
    }

    [Fact]
    public async Task DeleteSlot_Increments_Plan_Version()
    {
        var (userId, token) = await SignupAndLoginAsync("vdel@ex.com", "V");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId);
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);
        var slot = await AddHappySlotAsync(plan.Id, recipeId, CurrentMonday, MealSlot.Mittag, 2, null);

        var del = await _client.DeleteAsync($"/api/mealplans/{plan.Id}/slots/{slot.Id}");
        Assert.Equal(HttpStatusCode.NoContent, del.StatusCode);

        // Version: +1 for AddSlot, +1 for DeleteSlot = 2.
        var afterDelete = await FetchPlanAsync(_client, groupId, CurrentMonday);
        Assert.Equal(2, afterDelete.Version);
    }

    [Fact]
    public async Task CopyFrom_Increments_Target_Plan_Version()
    {
        var (userId, token) = await SignupAndLoginAsync("vcopy@ex.com", "V");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId);
        var source = await CreatePlanAsync(_client, groupId, PreviousMonday);
        await AddHappySlotAsync(source.Id, recipeId, PreviousMonday, MealSlot.Mittag, 2, null);
        var target = await CreatePlanAsync(_client, groupId, CurrentMonday);
        var targetBefore = await FetchPlanAsync(_client, groupId, CurrentMonday);
        Assert.Equal(0, targetBefore.Version);
        // Capture source.Version *before* the copy so we can assert
        // symmetrically below: target bumps, source stays. Source has
        // one AddSlot under its belt so its version is already ≥ 1.
        var sourceBefore = await FetchPlanAsync(_client, groupId, PreviousMonday);
        Assert.True(sourceBefore.Version >= 1);

        var res = await _client.PostAsync(
            $"/api/mealplans/{target.Id}/copy-from/{PreviousMonday:yyyy-MM-dd}", null);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);

        var targetAfter = await FetchPlanAsync(_client, groupId, CurrentMonday);
        Assert.Equal(1, targetAfter.Version);
        // Negative assert: source.Version must NOT change — copy is a
        // read-only op on the source side. Guards against a future
        // refactor accidentally bumping both plans' versions.
        var sourceAfter = await FetchPlanAsync(_client, groupId, PreviousMonday);
        Assert.Equal(sourceBefore.Version, sourceAfter.Version);
    }

    [Fact]
    public async Task CopyFrom_Returns_409_When_Target_Already_Has_Slots()
    {
        var (userId, token) = await SignupAndLoginAsync("cfconflict@ex.com", "C");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId);
        var source = await CreatePlanAsync(_client, groupId, PreviousMonday);
        await AddHappySlotAsync(source.Id, recipeId, PreviousMonday, MealSlot.Mittag, 2, null);
        var target = await CreatePlanAsync(_client, groupId, CurrentMonday);
        // Seed one slot in the target so the empty-target guard trips.
        await AddHappySlotAsync(target.Id, recipeId, CurrentMonday, MealSlot.Abend, 2, null);

        var res = await _client.PostAsync(
            $"/api/mealplans/{target.Id}/copy-from/{PreviousMonday:yyyy-MM-dd}", null);

        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
        var body = await res.Content.ReadFromJsonAsync<ErrorResponseDto>();
        Assert.NotNull(body);
        Assert.Equal("copy.target_not_empty", body!.Code);
    }

    // ── OFF3 ETag + If-Match ─────────────────────────────────────────

    [Fact]
    public async Task GET_MealPlan_Returns_ETag_Header()
    {
        var (_, token) = await SignupAndLoginAsync("etag-get@ex.com", "E");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);

        var res = await _client.GetAsync(
            $"/api/groups/{groupId}/mealplans/{CurrentMonday:yyyy-MM-dd}");

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.True(res.Headers.Contains("ETag"),
            "Expected ETag header on entity GET per OFF3.");
        var etag = res.Headers.GetValues("ETag").Single();
        Assert.Equal($"W/\"{plan.Id:D}-0\"", etag);
        // Cache-Control enables browser-conditional GET, per OFF3.
        Assert.True(res.Headers.Contains("Cache-Control") ||
                     res.Content.Headers.Contains("Cache-Control"));
    }

    [Fact]
    public async Task PatchSlot_With_Correct_IfMatch_Succeeds()
    {
        var (userId, token) = await SignupAndLoginAsync("if-match-ok@ex.com", "E");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId);
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);
        var slot = await AddHappySlotAsync(plan.Id, recipeId, CurrentMonday, MealSlot.Mittag, 2, null);
        // AddSlot bumped plan.Version to 1 — use that in If-Match.
        var afterAdd = await FetchPlanAsync(_client, groupId, CurrentMonday);

        using var req = new HttpRequestMessage(HttpMethod.Patch,
            $"/api/mealplans/{plan.Id}/slots/{slot.Id}")
        {
            Content = new StringContent("""{"servings": 4}""", Encoding.UTF8, "application/json"),
        };
        req.Headers.TryAddWithoutValidation("If-Match", $"W/\"{plan.Id:D}-{afterAdd.Version}\"");
        var res = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var updated = await FetchPlanAsync(_client, groupId, CurrentMonday);
        Assert.Equal(afterAdd.Version + 1, updated.Version);
    }

    [Fact]
    public async Task PatchSlot_With_Stale_IfMatch_Returns_409_With_Current_Dto()
    {
        var (userId, token) = await SignupAndLoginAsync("if-match-stale@ex.com", "E");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId);
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);
        var slot = await AddHappySlotAsync(plan.Id, recipeId, CurrentMonday, MealSlot.Mittag, 2, null);
        // First PATCH bumps to version 2; we'll attempt a second PATCH
        // with the stale pre-patch ETag = version 1.
        var stale = await FetchPlanAsync(_client, groupId, CurrentMonday);
        var firstPatch = await _client.PatchAsync(
            $"/api/mealplans/{plan.Id}/slots/{slot.Id}",
            new StringContent("""{"servings": 3}""", Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.OK, firstPatch.StatusCode);

        using var req = new HttpRequestMessage(HttpMethod.Patch,
            $"/api/mealplans/{plan.Id}/slots/{slot.Id}")
        {
            Content = new StringContent("""{"servings": 5}""", Encoding.UTF8, "application/json"),
        };
        req.Headers.TryAddWithoutValidation("If-Match", $"W/\"{plan.Id:D}-{stale.Version}\"");
        var res = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
        var body = await res.Content.ReadFromJsonAsync<ConflictBodyDto>();
        Assert.NotNull(body);
        Assert.Equal("version_mismatch", body!.Code);
        Assert.NotNull(body.Current);
        // `current` mirrors the normal GET shape: carries the newly
        // bumped version so the client can reconcile without a GET.
        Assert.Equal(stale.Version + 1, body.Current!.Value.GetProperty("version").GetInt32());
    }

    [Fact]
    public async Task PatchSlot_Without_IfMatch_Succeeds_For_Backcompat()
    {
        var (userId, token) = await SignupAndLoginAsync("if-match-none@ex.com", "E");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId);
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);
        var slot = await AddHappySlotAsync(plan.Id, recipeId, CurrentMonday, MealSlot.Mittag, 2, null);

        var res = await _client.PatchAsync(
            $"/api/mealplans/{plan.Id}/slots/{slot.Id}",
            new StringContent("""{"servings": 4}""", Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
    }

    [Fact]
    public async Task GET_After_Multiple_Mutations_Has_Incrementing_Version_In_ETag()
    {
        var (userId, token) = await SignupAndLoginAsync("multimut@ex.com", "E");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId);
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);
        await AddHappySlotAsync(plan.Id, recipeId, CurrentMonday, MealSlot.Mittag, 2, null);
        await AddHappySlotAsync(plan.Id, recipeId, CurrentMonday, MealSlot.Abend, 2, null);

        var res = await _client.GetAsync(
            $"/api/groups/{groupId}/mealplans/{CurrentMonday:yyyy-MM-dd}");

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var etag = res.Headers.GetValues("ETag").Single();
        Assert.Equal($"W/\"{plan.Id:D}-2\"", etag);
    }

    /// <summary>
    /// Wire shape for the OFF3 409 body — <c>current</c> is the full
    /// DTO the client should replace its local state with.
    /// </summary>
    private sealed record ConflictBodyDto(string Code, string Message, System.Text.Json.JsonElement? Current);

    // ── helpers ─────────────────────────────────────────────────────

    private async Task<MealPlanEndpoints.MealPlanDto> FetchPlanAsync(
        HttpClient client, Guid groupId, DateOnly weekStart)
    {
        var res = await client.GetAsync(
            $"/api/groups/{groupId}/mealplans/{weekStart:yyyy-MM-dd}");
        res.EnsureSuccessStatusCode();
        return (await res.Content.ReadFromJsonAsync<MealPlanEndpoints.MealPlanDto>())!;
    }

    private async Task<MealPlanEndpoints.MealPlanSlotDto> AddHappySlotAsync(
        Guid planId, Guid? recipeId, DateOnly date, MealSlot meal, int servings, string? label,
        HttpClient? client = null)
    {
        var c = client ?? _client;
        var res = await c.PostAsJsonAsync(
            $"/api/mealplans/{planId}/slots",
            new MealPlanEndpoints.AddSlotRequest(
                RecipeId: recipeId, Label: label, Date: date,
                Meal: meal, Servings: servings));
        res.EnsureSuccessStatusCode();
        return (await res.Content.ReadFromJsonAsync<MealPlanEndpoints.MealPlanSlotDto>())!;
    }
}
