using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using SharedCookbook.Api.Endpoints;
using SharedCookbook.Api.Endpoints.MealPlanning;
using SharedCookbook.Api.Tests.Infrastructure;
using SharedCookbook.Domain.Entities;
using SharedCookbook.Domain.Enums;
using SharedCookbook.Domain.MealPlanning;
using SharedCookbook.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace SharedCookbook.Api.Tests.Endpoints.MealPlanning;

/// <summary>
/// End-to-end tests for the P3-5 shopping-list endpoints. Covers
/// every route's happy path + 404 + 403, plus the merge-regen
/// behaviour (checked state survives, manual items survive,
/// carryover is not re-applied on regenerate).
/// </summary>
public class ShoppingListEndpointsTests : IClassFixture<SharedCookbookWebApplicationFactory>, IAsyncLifetime
{
    private static readonly DateOnly CurrentMonday = new(2026, 4, 20);
    private static readonly DateOnly PreviousMonday = new(2026, 4, 13);

    private readonly SharedCookbookWebApplicationFactory _factory;
    private HttpClient _client = null!;

    public ShoppingListEndpointsTests(SharedCookbookWebApplicationFactory factory)
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
        db.ShoppingListItems.RemoveRange(db.ShoppingListItems);
        db.ShoppingLists.RemoveRange(db.ShoppingLists);
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

    // ── Helpers ─────────────────────────────────────────────────────

    private async Task<(Guid UserId, string AccessToken)> SignupAndLoginAsync(string email, string displayName)
    {
        var adminToken = (await LoginAsync("admin@test.local", "AdminPassword123!")).AccessToken;
        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/invites/app/");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", adminToken);
        req.Content = JsonContent.Create(new { });
        var inviteRes = await _client.SendAsync(req);
        inviteRes.EnsureSuccessStatusCode();
        var invite = await inviteRes.Content.ReadDtoAsync<InviteEndpoints.CreateInviteResponse>();

        using var freshClient = _factory.CreateRateLimitBypassingClient(
            new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { HandleCookies = true });
        var signup = await freshClient.PostAsJsonAsync(
            $"/api/auth/signup?token={invite!.Token}",
            new AuthEndpoints.SignupRequest(email, "Passwort123!", displayName));
        signup.EnsureSuccessStatusCode();
        var body = await signup.Content.ReadDtoAsync<AuthEndpoints.AuthResponse>();
        return (body!.User.Id, body.AccessToken);
    }

    private async Task<AuthEndpoints.AuthResponse> LoginAsync(string email, string password)
    {
        using var client = _factory.CreateRateLimitBypassingClient(
            new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { HandleCookies = true });
        var response = await client.PostAsJsonAsync("/api/auth/login",
            new AuthEndpoints.LoginRequest(email, password));
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadDtoAsync<AuthEndpoints.AuthResponse>())!;
    }

    private static void AuthorizeClient(HttpClient client, string accessToken) =>
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);

    private async Task<Guid> CreateGroupAsync(HttpClient client, string name = "Kochbuch")
    {
        var create = await client.PostAsJsonAsync(
            "/api/groups",
            new GroupEndpoints.CreateGroupRequest(name, null, null));
        create.EnsureSuccessStatusCode();
        var body = (await create.Content.ReadDtoAsync<GroupEndpoints.GroupSummaryDto>())!;
        return body.Id;
    }

    /// <summary>
    /// Seeds a recipe with the given ingredients and returns the
    /// recipe's Id. Bypasses the POST /recipes endpoint to keep the
    /// fixture setup concise for shopping-list tests.
    /// </summary>
    private async Task<Guid> SeedRecipeAsync(
        Guid groupId, Guid creatorUserId, string title,
        int defaultServings,
        params (decimal? qty, string unit, string name)[] ingredients)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var recipe = new Recipe(
            groupId: groupId,
            createdByUserId: creatorUserId,
            title: title,
            description: null,
            defaultServings: defaultServings,
            prepTimeMinutes: 20,
            difficulty: 1,
            sourceUrl: null,
            sourceType: RecipeSourceType.Manual,
            forkOfRecipeId: null,
            createdAt: DateTimeOffset.UtcNow);
        // COMP-0 — seed one default component and anchor every
        // test ingredient on it via the aggregate's invariant enforcer.
        var defaultComponent = new RecipeComponent(recipe.Id, 0, null);
        var materialized = new List<Ingredient>();
        for (var i = 0; i < ingredients.Length; i++)
        {
            var (qty, unit, name) = ingredients[i];
            var scalable = qty.HasValue && qty.Value > 0m;
            materialized.Add(new Ingredient(
                recipeId: recipe.Id, componentId: defaultComponent.Id, position: i,
                quantity: qty, unit: unit, name: name,
                note: null, scalable: scalable));
        }
        recipe.ReplaceComponents(new[] { defaultComponent }, materialized, Array.Empty<RecipeStep>());
        db.Recipes.Add(recipe);
        await db.SaveChangesAsync();
        return recipe.Id;
    }

    private async Task<MealPlanEndpoints.MealPlanDto> CreatePlanAsync(
        HttpClient client, Guid groupId, DateOnly weekStart)
    {
        var res = await client.PostAsJsonAsync(
            $"/api/groups/{groupId}/mealplans",
            new MealPlanEndpoints.CreateMealPlanRequest(weekStart));
        Assert.Equal(HttpStatusCode.Created, res.StatusCode);
        return (await res.Content.ReadDtoAsync<MealPlanEndpoints.MealPlanDto>())!;
    }

    private async Task<MealPlanEndpoints.MealPlanSlotDto> AddSlotAsync(
        Guid planId, Guid? recipeId, DateOnly date, MealSlot meal, int servings, string? label = null)
    {
        var res = await _client.PostAsJsonAsync(
            $"/api/mealplans/{planId}/slots",
            new MealPlanEndpoints.AddSlotRequest(
                RecipeId: recipeId, Label: label, Date: date, Meal: meal, Servings: servings));
        res.EnsureSuccessStatusCode();
        return (await res.Content.ReadDtoAsync<MealPlanEndpoints.MealPlanSlotDto>())!;
    }

    private async Task<ShoppingListEndpoints.ShoppingListDto> GenerateAsync(Guid planId)
    {
        var res = await _client.PostAsync($"/api/mealplans/{planId}/shopping-list/generate", null);
        res.EnsureSuccessStatusCode();
        return (await res.Content.ReadDtoAsync<ShoppingListEndpoints.ShoppingListDto>())!;
    }

    // ── GET /api/mealplans/{planId}/shopping-list ───────────────────

    [Fact]
    public async Task Get_Returns_404_When_No_List_Generated_Yet()
    {
        var (_, token) = await SignupAndLoginAsync("get.noli@ex.com", "G");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);

        var res = await _client.GetAsync($"/api/mealplans/{plan.Id}/shopping-list");

        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }

    [Fact]
    public async Task Get_Returns_List_After_Generate()
    {
        var (userId, token) = await SignupAndLoginAsync("get.ok@ex.com", "G");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId, "Pasta", 2, (200m, "g", "Spaghetti"));
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);
        await AddSlotAsync(plan.Id, recipeId, CurrentMonday, MealSlot.Mittag, 2);
        await GenerateAsync(plan.Id);

        var res = await _client.GetAsync($"/api/mealplans/{plan.Id}/shopping-list");

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var body = (await res.Content.ReadDtoAsync<ShoppingListEndpoints.ShoppingListDto>())!;
        Assert.Single(body.Items);
        Assert.Equal("Spaghetti", body.Items[0].Name);
    }

    [Fact]
    public async Task Get_Returns_404_For_Unknown_Plan()
    {
        var (_, token) = await SignupAndLoginAsync("get.404@ex.com", "G");
        AuthorizeClient(_client, token);
        var res = await _client.GetAsync($"/api/mealplans/{Guid.NewGuid()}/shopping-list");
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }

    [Fact]
    public async Task Get_Returns_403_For_Non_Member()
    {
        var (_, aTok) = await SignupAndLoginAsync("geta@ex.com", "A");
        var (_, bTok) = await SignupAndLoginAsync("getb@ex.com", "B");
        using var a = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(a, aTok);
        var groupId = await CreateGroupAsync(a);
        var plan = await CreatePlanAsync(a, groupId, CurrentMonday);

        using var b = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(b, bTok);
        var res = await b.GetAsync($"/api/mealplans/{plan.Id}/shopping-list");

        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
    }

    [Fact]
    public async Task Get_Returns_401_When_Unauthenticated()
    {
        var res = await _client.GetAsync($"/api/mealplans/{Guid.NewGuid()}/shopping-list");
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
    }

    // ── POST /shopping-list/generate ───────────────────────────────

    [Fact]
    public async Task Generate_Creates_Fresh_List_From_Slot_Ingredients()
    {
        var (userId, token) = await SignupAndLoginAsync("gen.fresh@ex.com", "F");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId, "Curry", 2,
            (100m, "g", "Linsen"), (2m, "Stück", "Zwiebel"));
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);
        await AddSlotAsync(plan.Id, recipeId, CurrentMonday, MealSlot.Mittag, 4);     // scale 2x

        var res = await _client.PostAsync($"/api/mealplans/{plan.Id}/shopping-list/generate", null);

        Assert.Equal(HttpStatusCode.Created, res.StatusCode);
        var body = (await res.Content.ReadDtoAsync<ShoppingListEndpoints.ShoppingListDto>())!;
        Assert.Equal(2, body.Items.Length);
        Assert.Contains(body.Items, i => i.Name == "Linsen" && i.Quantity == "200");
        Assert.Contains(body.Items, i => i.Name == "Zwiebel" && i.Quantity == "4");
    }

    [Fact]
    public async Task Generate_Skips_Leftover_Slot_Ingredients()
    {
        // Regression: the aggregator MUST skip ParentSlotId-bearing
        // slots so meal-prep leftovers don't double-count. End-to-end
        // version of the ShoppingListGenerator test.
        var (userId, token) = await SignupAndLoginAsync("gen.left@ex.com", "L");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId, "Curry", 2, (100m, "g", "Linsen"));
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);
        var parent = await AddSlotAsync(plan.Id, recipeId, CurrentMonday, MealSlot.Mittag, 4);
        var childResp = await _client.PostAsJsonAsync(
            $"/api/mealplans/{plan.Id}/slots",
            new MealPlanEndpoints.AddSlotRequest(
                RecipeId: recipeId, Label: null, Date: CurrentMonday.AddDays(1),
                Meal: MealSlot.Mittag, Servings: 1, SortOrder: null,
                ParentSlotId: parent.Id));
        childResp.EnsureSuccessStatusCode();

        var list = await GenerateAsync(plan.Id);

        var linsen = Assert.Single(list.Items);
        // 200g from parent only, leftover does NOT add 50g.
        Assert.Equal("200", linsen.Quantity);
    }

    [Fact]
    public async Task Generate_Applies_Carryover_From_Previous_Week_On_First_Generate()
    {
        var (userId, token) = await SignupAndLoginAsync("gen.carry@ex.com", "C");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId, "Salat", 2, (1m, "Stück", "Tomate"));

        // Previous week has a list with 1 unchecked "Avocado" +
        // 1 checked "Tomate" that should NOT carry over.
        var prevPlan = await CreatePlanAsync(_client, groupId, PreviousMonday);
        await AddSlotAsync(prevPlan.Id, recipeId, PreviousMonday, MealSlot.Mittag, 2);
        var prevList = await GenerateAsync(prevPlan.Id);
        // Mark the Tomate checked (already bought).
        var tomate = prevList.Items.Single(i => i.Name == "Tomate");
        var patch = await _client.PatchAsync(
            $"/api/shopping-lists/{prevList.Id}/items/{tomate.Id}",
            new StringContent("""{"isChecked": true}""", Encoding.UTF8, "application/json"));
        patch.EnsureSuccessStatusCode();
        // Manually add an unchecked Avocado to the prev list.
        var addRes = await _client.PostAsJsonAsync(
            $"/api/shopping-lists/{prevList.Id}/items",
            new ShoppingListEndpoints.AddItemRequest("Avocado", "2", "Stück"));
        addRes.EnsureSuccessStatusCode();

        // New week.
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);
        await AddSlotAsync(plan.Id, recipeId, CurrentMonday, MealSlot.Mittag, 2);
        var list = await GenerateAsync(plan.Id);

        // Should contain Tomate from the new week (no carryover of
        // checked item) but NO Avocado because it was Manual
        // source (plan §Carryover: manual items never carry over).
        var names = list.Items.Select(i => i.Name).ToArray();
        Assert.Contains("Tomate", names);
        Assert.DoesNotContain("Avocado", names);
    }

    [Fact]
    public async Task Generate_Carries_Over_Unchecked_FromPlan_Item()
    {
        // Build two weeks where the previous week has an unchecked
        // FromPlan item that should appear in the new week tagged
        // as carried-over.
        var (userId, token) = await SignupAndLoginAsync("gen.carry2@ex.com", "C");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var oldRecipe = await SeedRecipeAsync(groupId, userId, "Old", 2, (1m, "Stück", "Mango"));
        var newRecipe = await SeedRecipeAsync(groupId, userId, "New", 2, (1m, "Stück", "Zitrone"));

        var prevPlan = await CreatePlanAsync(_client, groupId, PreviousMonday);
        await AddSlotAsync(prevPlan.Id, oldRecipe, PreviousMonday, MealSlot.Mittag, 2);
        await GenerateAsync(prevPlan.Id); // Mango unchecked

        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);
        await AddSlotAsync(plan.Id, newRecipe, CurrentMonday, MealSlot.Mittag, 2);
        var list = await GenerateAsync(plan.Id);

        Assert.Contains(list.Items, i => i.Name == "Mango"
            && i.CarriedOverFromPreviousWeek
            && i.Source == ShoppingListItemSource.CarriedOver);
        Assert.Contains(list.Items, i => i.Name == "Zitrone"
            && !i.CarriedOverFromPreviousWeek
            && i.Source == ShoppingListItemSource.FromPlan);
    }

    [Fact]
    public async Task Regenerate_Preserves_IsChecked_State_On_Matching_Items()
    {
        var (userId, token) = await SignupAndLoginAsync("regen.chk@ex.com", "R");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId, "R", 2, (100m, "g", "Mehl"));
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);
        await AddSlotAsync(plan.Id, recipeId, CurrentMonday, MealSlot.Mittag, 2);
        var list = await GenerateAsync(plan.Id);

        // Mark the item checked.
        var mehl = list.Items.Single();
        var patch = await _client.PatchAsync(
            $"/api/shopping-lists/{list.Id}/items/{mehl.Id}",
            new StringContent("""{"isChecked": true}""", Encoding.UTF8, "application/json"));
        patch.EnsureSuccessStatusCode();

        // Regenerate — the quantity should stay (same slot setup)
        // AND isChecked must survive.
        var regen = await _client.PostAsync(
            $"/api/mealplans/{plan.Id}/shopping-list/generate", null);
        Assert.Equal(HttpStatusCode.OK, regen.StatusCode);
        var body = (await regen.Content.ReadDtoAsync<ShoppingListEndpoints.ShoppingListDto>())!;
        var again = body.Items.Single(i => i.Name == "Mehl");
        Assert.True(again.IsChecked);
    }

    [Fact]
    public async Task Regenerate_Recomputes_Quantity_When_Servings_Changed()
    {
        var (userId, token) = await SignupAndLoginAsync("regen.qty@ex.com", "Q");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId, "R", 2, (100m, "g", "Mehl"));
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);
        var slot = await AddSlotAsync(plan.Id, recipeId, CurrentMonday, MealSlot.Mittag, 2);
        var list = await GenerateAsync(plan.Id);
        Assert.Equal("100", list.Items.Single().Quantity);

        // Bump servings to 4 → quantity must become 200g.
        var slotPatch = await _client.PatchAsync(
            $"/api/mealplans/{plan.Id}/slots/{slot.Id}",
            new StringContent("""{"servings": 4}""", Encoding.UTF8, "application/json"));
        slotPatch.EnsureSuccessStatusCode();

        var regen = await _client.PostAsync(
            $"/api/mealplans/{plan.Id}/shopping-list/generate", null);
        var body = (await regen.Content.ReadDtoAsync<ShoppingListEndpoints.ShoppingListDto>())!;
        Assert.Equal("200", body.Items.Single(i => i.Name == "Mehl").Quantity);
    }

    [Fact]
    public async Task Regenerate_Preserves_Manual_Items()
    {
        var (userId, token) = await SignupAndLoginAsync("regen.man@ex.com", "M");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId, "R", 2, (100m, "g", "Mehl"));
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);
        await AddSlotAsync(plan.Id, recipeId, CurrentMonday, MealSlot.Mittag, 2);
        var list = await GenerateAsync(plan.Id);

        // User types in Klopapier manually.
        var add = await _client.PostAsJsonAsync(
            $"/api/shopping-lists/{list.Id}/items",
            new ShoppingListEndpoints.AddItemRequest("Klopapier", "1", "Packung"));
        add.EnsureSuccessStatusCode();

        var regen = await _client.PostAsync(
            $"/api/mealplans/{plan.Id}/shopping-list/generate", null);
        var body = (await regen.Content.ReadDtoAsync<ShoppingListEndpoints.ShoppingListDto>())!;
        Assert.Contains(body.Items, i => i.Name == "Klopapier"
            && i.Source == ShoppingListItemSource.Manual);
    }

    [Fact]
    public async Task Regenerate_Does_Not_Reapply_Carryover()
    {
        // User generated the list last week. "eine Prise Salz" from
        // that recipe was carried over. A second regenerate of the
        // same week must NOT re-apply carryover — otherwise checked
        // carryover items would silently flip provenance.
        var (userId, token) = await SignupAndLoginAsync("regen.noc@ex.com", "N");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipe = await SeedRecipeAsync(groupId, userId, "R", 2, (1m, "Stück", "Gurke"));
        var prevRecipe = await SeedRecipeAsync(groupId, userId, "Old", 2, (1m, "Stück", "Kohl"));

        // prev week list has unchecked Kohl
        var prevPlan = await CreatePlanAsync(_client, groupId, PreviousMonday);
        await AddSlotAsync(prevPlan.Id, prevRecipe, PreviousMonday, MealSlot.Mittag, 2);
        await GenerateAsync(prevPlan.Id);

        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);
        await AddSlotAsync(plan.Id, recipe, CurrentMonday, MealSlot.Mittag, 2);
        var first = await GenerateAsync(plan.Id);
        // Kohl carried over + Gurke from new plan.
        Assert.Equal(2, first.Items.Length);
        var kohl = first.Items.Single(i => i.Name == "Kohl");
        Assert.True(kohl.CarriedOverFromPreviousWeek);

        // User deletes the carried-over Kohl (no longer needs it).
        var del = await _client.DeleteAsync(
            $"/api/shopping-lists/{first.Id}/items/{kohl.Id}");
        del.EnsureSuccessStatusCode();

        // Regenerate — Kohl must NOT come back, even though it's
        // still unchecked on last week's list.
        var regen = await _client.PostAsync(
            $"/api/mealplans/{plan.Id}/shopping-list/generate", null);
        var body = (await regen.Content.ReadDtoAsync<ShoppingListEndpoints.ShoppingListDto>())!;
        Assert.DoesNotContain(body.Items, i => i.Name == "Kohl");
    }

    [Fact]
    public async Task Generate_Returns_403_For_Non_Member()
    {
        var (userA, aTok) = await SignupAndLoginAsync("gaa@ex.com", "A");
        var (_, bTok) = await SignupAndLoginAsync("gab@ex.com", "B");
        using var a = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(a, aTok);
        var groupId = await CreateGroupAsync(a);
        var plan = await CreatePlanAsync(a, groupId, CurrentMonday);

        using var b = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(b, bTok);
        var res = await b.PostAsync(
            $"/api/mealplans/{plan.Id}/shopping-list/generate", null);

        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
    }

    [Fact]
    public async Task Generate_Returns_404_For_Unknown_Plan()
    {
        var (_, token) = await SignupAndLoginAsync("gnf@ex.com", "N");
        AuthorizeClient(_client, token);
        var res = await _client.PostAsync(
            $"/api/mealplans/{Guid.NewGuid()}/shopping-list/generate", null);
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }

    // ── PATCH /shopping-lists/{id}/items/{itemId} ──────────────────

    [Fact]
    public async Task PatchItem_Toggles_IsChecked()
    {
        var (userId, token) = await SignupAndLoginAsync("pi.chk@ex.com", "C");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId, "R", 2, (1m, "g", "Salz"));
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);
        await AddSlotAsync(plan.Id, recipeId, CurrentMonday, MealSlot.Mittag, 2);
        var list = await GenerateAsync(plan.Id);
        var item = list.Items.Single();

        var res = await _client.PatchAsync(
            $"/api/shopping-lists/{list.Id}/items/{item.Id}",
            new StringContent("""{"isChecked": true}""", Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var body = (await res.Content.ReadDtoAsync<ShoppingListEndpoints.ShoppingListItemDto>())!;
        Assert.True(body.IsChecked);
    }

    [Fact]
    public async Task PatchItem_Updates_Note()
    {
        var (userId, token) = await SignupAndLoginAsync("pi.nt@ex.com", "N");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId, "R", 2, (1m, "g", "Salz"));
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);
        await AddSlotAsync(plan.Id, recipeId, CurrentMonday, MealSlot.Mittag, 2);
        var list = await GenerateAsync(plan.Id);
        var item = list.Items.Single();

        var res = await _client.PatchAsync(
            $"/api/shopping-lists/{list.Id}/items/{item.Id}",
            new StringContent("""{"note": "bio wenn möglich"}""", Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var body = (await res.Content.ReadDtoAsync<ShoppingListEndpoints.ShoppingListItemDto>())!;
        Assert.Equal("bio wenn möglich", body.Note);
    }

    [Fact]
    public async Task PatchItem_Returns_404_For_Unknown_Item()
    {
        var (userId, token) = await SignupAndLoginAsync("pi.404@ex.com", "N");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId, "R", 2, (1m, "g", "Salz"));
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);
        await AddSlotAsync(plan.Id, recipeId, CurrentMonday, MealSlot.Mittag, 2);
        var list = await GenerateAsync(plan.Id);

        var res = await _client.PatchAsync(
            $"/api/shopping-lists/{list.Id}/items/{Guid.NewGuid()}",
            new StringContent("""{"isChecked": true}""", Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }

    [Fact]
    public async Task PatchItem_Returns_403_For_Non_Member()
    {
        var (userA, aTok) = await SignupAndLoginAsync("pia@ex.com", "A");
        var (_, bTok) = await SignupAndLoginAsync("pib@ex.com", "B");
        using var a = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(a, aTok);
        var groupId = await CreateGroupAsync(a);
        var recipeId = await SeedRecipeAsync(groupId, userA, "R", 2, (1m, "g", "Salz"));
        var plan = await CreatePlanAsync(a, groupId, CurrentMonday);
        var slotRes = await a.PostAsJsonAsync(
            $"/api/mealplans/{plan.Id}/slots",
            new MealPlanEndpoints.AddSlotRequest(recipeId, null, CurrentMonday, MealSlot.Mittag, 2));
        slotRes.EnsureSuccessStatusCode();
        var genRes = await a.PostAsync($"/api/mealplans/{plan.Id}/shopping-list/generate", null);
        genRes.EnsureSuccessStatusCode();
        var list = (await genRes.Content.ReadDtoAsync<ShoppingListEndpoints.ShoppingListDto>())!;
        var item = list.Items.Single();

        using var b = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(b, bTok);
        var res = await b.PatchAsync(
            $"/api/shopping-lists/{list.Id}/items/{item.Id}",
            new StringContent("""{"isChecked": true}""", Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
    }

    // ── POST /shopping-lists/{id}/items ────────────────────────────

    [Fact]
    public async Task AddItem_Creates_Manual_Item()
    {
        var (userId, token) = await SignupAndLoginAsync("add.ok@ex.com", "A");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId, "R", 2, (1m, "g", "Salz"));
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);
        await AddSlotAsync(plan.Id, recipeId, CurrentMonday, MealSlot.Mittag, 2);
        var list = await GenerateAsync(plan.Id);

        var res = await _client.PostAsJsonAsync(
            $"/api/shopping-lists/{list.Id}/items",
            new ShoppingListEndpoints.AddItemRequest("Toilettenpapier", "1", "Packung", Note: "großer Rollen"));

        Assert.Equal(HttpStatusCode.Created, res.StatusCode);
        var body = (await res.Content.ReadDtoAsync<ShoppingListEndpoints.ShoppingListItemDto>())!;
        Assert.Equal("Toilettenpapier", body.Name);
        Assert.Equal(ShoppingListItemSource.Manual, body.Source);
        Assert.False(body.IsChecked);
    }

    [Fact]
    public async Task AddItem_Rejects_Blank_Name()
    {
        var (userId, token) = await SignupAndLoginAsync("add.blank@ex.com", "B");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId, "R", 2, (1m, "g", "Salz"));
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);
        await AddSlotAsync(plan.Id, recipeId, CurrentMonday, MealSlot.Mittag, 2);
        var list = await GenerateAsync(plan.Id);

        var res = await _client.PostAsJsonAsync(
            $"/api/shopping-lists/{list.Id}/items",
            new ShoppingListEndpoints.AddItemRequest("   "));

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    [Fact]
    public async Task AddItem_Returns_404_For_Unknown_List()
    {
        var (_, token) = await SignupAndLoginAsync("add.404@ex.com", "N");
        AuthorizeClient(_client, token);
        var res = await _client.PostAsJsonAsync(
            $"/api/shopping-lists/{Guid.NewGuid()}/items",
            new ShoppingListEndpoints.AddItemRequest("X"));
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }

    [Fact]
    public async Task AddItem_Rejects_Out_Of_Range_Category_Enum()
    {
        // Defense-in-depth: System.Text.Json will cast any int into an
        // enum without complaining, so a malicious / buggy client
        // could POST { "category": 9999 } and persist a bucket nothing
        // in the UI knows how to render. Endpoint must 400 with
        // "category.invalid" before touching the DB.
        var (userId, token) = await SignupAndLoginAsync("add.catx@ex.com", "X");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId, "R", 2, (1m, "g", "Salz"));
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);
        await AddSlotAsync(plan.Id, recipeId, CurrentMonday, MealSlot.Mittag, 2);
        var list = await GenerateAsync(plan.Id);

        var res = await _client.PostAsync(
            $"/api/shopping-lists/{list.Id}/items",
            new StringContent(
                """{"name":"Haribo","category":9999}""",
                Encoding.UTF8,
                "application/json"));

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        var body = await res.Content.ReadAsStringAsync();
        Assert.Contains("invalid_category", body);
    }

    // ── DELETE /shopping-lists/{id}/items/{itemId} ─────────────────

    [Fact]
    public async Task DeleteItem_Removes_Item()
    {
        var (userId, token) = await SignupAndLoginAsync("del.ok@ex.com", "D");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId, "R", 2, (1m, "g", "Salz"));
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);
        await AddSlotAsync(plan.Id, recipeId, CurrentMonday, MealSlot.Mittag, 2);
        var list = await GenerateAsync(plan.Id);
        var item = list.Items.Single();

        var res = await _client.DeleteAsync(
            $"/api/shopping-lists/{list.Id}/items/{item.Id}");

        Assert.Equal(HttpStatusCode.NoContent, res.StatusCode);
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        Assert.False(await db.ShoppingListItems.AnyAsync(i => i.Id == item.Id));
    }

    [Fact]
    public async Task DeleteItem_Returns_404_For_Unknown_Item()
    {
        var (userId, token) = await SignupAndLoginAsync("del.404@ex.com", "D");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId, "R", 2, (1m, "g", "Salz"));
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);
        await AddSlotAsync(plan.Id, recipeId, CurrentMonday, MealSlot.Mittag, 2);
        var list = await GenerateAsync(plan.Id);

        var res = await _client.DeleteAsync(
            $"/api/shopping-lists/{list.Id}/items/{Guid.NewGuid()}");

        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }

    // ── OFF3 ETag + If-Match ─────────────────────────────────────────

    [Fact]
    public async Task GET_ShoppingList_Returns_ETag_Header()
    {
        var (userId, token) = await SignupAndLoginAsync("sl-etag@ex.com", "E");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId, "R", 2, (1m, "g", "Salz"));
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);
        await AddSlotAsync(plan.Id, recipeId, CurrentMonday, MealSlot.Mittag, 2);
        var list = await GenerateAsync(plan.Id);

        var res = await _client.GetAsync($"/api/mealplans/{plan.Id}/shopping-list");

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.True(res.Headers.Contains("ETag"));
        var etag = res.Headers.GetValues("ETag").Single();
        Assert.Equal($"W/\"{list.Id:D}-{list.Version}\"", etag);
    }

    [Fact]
    public async Task PatchItem_With_Correct_IfMatch_Succeeds()
    {
        var (userId, token) = await SignupAndLoginAsync("sl-patch-ok@ex.com", "E");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId, "R", 2, (1m, "g", "Salz"));
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);
        await AddSlotAsync(plan.Id, recipeId, CurrentMonday, MealSlot.Mittag, 2);
        var list = await GenerateAsync(plan.Id);
        var item = list.Items[0];

        using var req = new HttpRequestMessage(HttpMethod.Patch,
            $"/api/shopping-lists/{list.Id}/items/{item.Id}")
        {
            Content = new StringContent("""{"isChecked": true}""", Encoding.UTF8, "application/json"),
        };
        req.Headers.TryAddWithoutValidation("If-Match", $"W/\"{list.Id:D}-{list.Version}\"");
        var res = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
    }

    [Fact]
    public async Task PatchItem_With_Stale_IfMatch_Returns_409_With_Current_List()
    {
        var (userId, token) = await SignupAndLoginAsync("sl-patch-stale@ex.com", "E");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId, "R", 2, (1m, "g", "Salz"));
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);
        await AddSlotAsync(plan.Id, recipeId, CurrentMonday, MealSlot.Mittag, 2);
        var list = await GenerateAsync(plan.Id);
        var item = list.Items[0];
        var staleVersion = list.Version;

        // Move the list forward with a manual PATCH (no If-Match).
        var firstPatch = await _client.PatchAsync(
            $"/api/shopping-lists/{list.Id}/items/{item.Id}",
            new StringContent("""{"isChecked": true}""", Encoding.UTF8, "application/json"));
        firstPatch.EnsureSuccessStatusCode();

        using var req = new HttpRequestMessage(HttpMethod.Patch,
            $"/api/shopping-lists/{list.Id}/items/{item.Id}")
        {
            Content = new StringContent("""{"isChecked": false}""", Encoding.UTF8, "application/json"),
        };
        req.Headers.TryAddWithoutValidation("If-Match", $"W/\"{list.Id:D}-{staleVersion}\"");
        var res = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
        var body = await res.Content.ReadDtoAsync<OFF3ConflictBodyDto>();
        Assert.NotNull(body);
        Assert.Equal("version_mismatch", body!.Code);
        Assert.NotNull(body.Current);
        Assert.Equal(staleVersion + 1, body.Current!.Value.GetProperty("version").GetInt32());
    }

    [Fact]
    public async Task PatchItem_Without_IfMatch_Succeeds_For_Backcompat()
    {
        var (userId, token) = await SignupAndLoginAsync("sl-patch-none@ex.com", "E");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId, "R", 2, (1m, "g", "Salz"));
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);
        await AddSlotAsync(plan.Id, recipeId, CurrentMonday, MealSlot.Mittag, 2);
        var list = await GenerateAsync(plan.Id);
        var item = list.Items[0];

        var res = await _client.PatchAsync(
            $"/api/shopping-lists/{list.Id}/items/{item.Id}",
            new StringContent("""{"isChecked": true}""", Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
    }

    [Fact]
    public async Task GET_ShoppingList_After_Multiple_Item_Mutations_Has_Incrementing_Version()
    {
        var (userId, token) = await SignupAndLoginAsync("sl-multi@ex.com", "E");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await SeedRecipeAsync(groupId, userId, "R", 2, (1m, "g", "Salz"));
        var plan = await CreatePlanAsync(_client, groupId, CurrentMonday);
        await AddSlotAsync(plan.Id, recipeId, CurrentMonday, MealSlot.Mittag, 2);
        var list = await GenerateAsync(plan.Id);
        var item = list.Items[0];
        var baseline = list.Version;

        (await _client.PatchAsync(
            $"/api/shopping-lists/{list.Id}/items/{item.Id}",
            new StringContent("""{"isChecked": true}""", Encoding.UTF8, "application/json")))
            .EnsureSuccessStatusCode();
        (await _client.PatchAsync(
            $"/api/shopping-lists/{list.Id}/items/{item.Id}",
            new StringContent("""{"isChecked": false}""", Encoding.UTF8, "application/json")))
            .EnsureSuccessStatusCode();

        var res = await _client.GetAsync($"/api/mealplans/{plan.Id}/shopping-list");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var etag = res.Headers.GetValues("ETag").Single();
        Assert.Equal($"W/\"{list.Id:D}-{baseline + 2}\"", etag);
    }

    private sealed record OFF3ConflictBodyDto(string Code, string Message, System.Text.Json.JsonElement? Current);
}
