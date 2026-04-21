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
/// End-to-end tests for the S4 Search + Random endpoints. Uses the SQLite
/// in-memory test host, so the service's LIKE-fallback branch is what's
/// actually running — Postgres tsvector behaviour is verified end-to-end
/// via docker acceptance.
/// </summary>
public class SearchEndpointsTests : IClassFixture<FamilienKochbuchWebApplicationFactory>, IAsyncLifetime
{
    private readonly FamilienKochbuchWebApplicationFactory _factory;
    private HttpClient _client = null!;

    public SearchEndpointsTests(FamilienKochbuchWebApplicationFactory factory)
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
            db.Tags.Add(Domain.Entities.Tag.CreateGlobal("schnell", TagCategory.Aufwand));
            db.Tags.Add(Domain.Entities.Tag.CreateGlobal("vegetarisch", TagCategory.Diaet));
            db.Tags.Add(Domain.Entities.Tag.CreateGlobal("warm", TagCategory.Typ));
            db.Tags.Add(Domain.Entities.Tag.CreateGlobal("Mittag", TagCategory.Mahlzeit));
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

    private static RecipeEndpoints.CreateRecipeRequest BuildCreate(
        string title,
        int? prepTimeMinutes = 30,
        Guid[]? tagIds = null,
        string[]? ingredientNames = null)
    {
        var names = ingredientNames ?? new[] { "Mehl" };
        var ingredients = names.Select((n, idx) =>
            new RecipeEndpoints.IngredientRequest(idx, 100m, "g", n, null, true)).ToArray();
        return new RecipeEndpoints.CreateRecipeRequest(
            Title: title,
            Description: null,
            DefaultServings: 4,
            PrepTimeMinutes: prepTimeMinutes,
            Difficulty: 1,
            SourceUrl: null,
            Components: new[]
            {
                new RecipeEndpoints.RecipeComponentRequest(
                    Position: 0, Label: null,
                    Ingredients: ingredients,
                    Steps: new[] { new RecipeEndpoints.StepRequest(0, "Kochen.") }),
            },
            TagIds: tagIds ?? Array.Empty<Guid>());
    }

    private async Task<Guid[]> GetSeededTagIdsAsync()
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        return await db.Tags.Where(t => t.GroupId == null).OrderBy(t => t.Name)
            .Select(t => t.Id).ToArrayAsync();
    }

    // ── Search ──────────────────────────────────────────────────────────

    [Fact]
    public async Task Search_Filter_By_Query_Returns_Matches_Only()
    {
        var (_, token) = await SignupAndLoginAsync("s1@ex.com", "S");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);

        await _client.PostAsJsonAsync($"/api/groups/{groupId}/recipes",
            BuildCreate("Nudeln Carbonara", ingredientNames: new[] { "Nudeln", "Speck" }));
        await _client.PostAsJsonAsync($"/api/groups/{groupId}/recipes", BuildCreate("Pizza Margherita"));
        await _client.PostAsJsonAsync($"/api/groups/{groupId}/recipes", BuildCreate("Salat"));

        var search = await _client.GetFromJsonAsync<SearchEndpoints.SearchResultDto>(
            $"/api/groups/{groupId}/recipes/search?q=Nudeln");

        Assert.Equal(1, search!.Total);
        Assert.Equal("Nudeln Carbonara", search.Items[0].Title);
    }

    [Fact]
    public async Task Search_Filter_By_Multiple_Tags_AND()
    {
        var (_, token) = await SignupAndLoginAsync("s2@ex.com", "S");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var tagIds = await GetSeededTagIdsAsync();
        var schnell = tagIds[0];
        var vegetarisch = tagIds[1];

        await _client.PostAsJsonAsync($"/api/groups/{groupId}/recipes",
            BuildCreate("Alles", tagIds: new[] { schnell, vegetarisch }));
        await _client.PostAsJsonAsync($"/api/groups/{groupId}/recipes",
            BuildCreate("NurEins", tagIds: new[] { schnell }));
        await _client.PostAsJsonAsync($"/api/groups/{groupId}/recipes",
            BuildCreate("Keines"));

        var tagCsv = $"{schnell},{vegetarisch}";
        var search = await _client.GetFromJsonAsync<SearchEndpoints.SearchResultDto>(
            $"/api/groups/{groupId}/recipes/search?tags={tagCsv}");

        Assert.Equal(1, search!.Total);
        Assert.Equal("Alles", search.Items[0].Title);
    }

    [Fact]
    public async Task Search_Summary_Includes_AvgRating_RatingCount_MyStars()
    {
        var (_, token) = await SignupAndLoginAsync("s3@ex.com", "S");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);

        var createRes = await _client.PostAsJsonAsync(
            $"/api/groups/{groupId}/recipes", BuildCreate("Bewertet"));
        var recipe = (await createRes.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;

        await _client.PostAsJsonAsync($"/api/recipes/{recipe.Id}/ratings",
            new RatingEndpoints.UpsertRatingRequest(4, null));

        var search = await _client.GetFromJsonAsync<SearchEndpoints.SearchResultDto>(
            $"/api/groups/{groupId}/recipes/search");

        var summary = Assert.Single(search!.Items);
        Assert.Equal(4.0, summary.AvgRating);
        Assert.Equal(1, summary.RatingCount);
        Assert.Equal(4, summary.MyStars);
    }

    [Fact]
    public async Task Search_Combines_Q_Tags_MinRating()
    {
        var (_, token) = await SignupAndLoginAsync("s4@ex.com", "S");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var tagIds = await GetSeededTagIdsAsync();
        var schnell = tagIds[0];

        // Winner: q matches + has tag + rating >= 4.
        var winnerRes = await _client.PostAsJsonAsync($"/api/groups/{groupId}/recipes",
            BuildCreate("Schnelle Nudeln", ingredientNames: new[] { "Nudeln" },
                tagIds: new[] { schnell }));
        var winner = (await winnerRes.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;
        await _client.PostAsJsonAsync($"/api/recipes/{winner.Id}/ratings",
            new RatingEndpoints.UpsertRatingRequest(5, null));

        // Q match but no tag.
        await _client.PostAsJsonAsync($"/api/groups/{groupId}/recipes",
            BuildCreate("Nudeln ohne Tag", ingredientNames: new[] { "Nudeln" }));
        // Q match + tag but low rating.
        var lowRes = await _client.PostAsJsonAsync($"/api/groups/{groupId}/recipes",
            BuildCreate("Nudeln schlecht", ingredientNames: new[] { "Nudeln" },
                tagIds: new[] { schnell }));
        var low = (await lowRes.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;
        await _client.PostAsJsonAsync($"/api/recipes/{low.Id}/ratings",
            new RatingEndpoints.UpsertRatingRequest(1, null));

        var search = await _client.GetFromJsonAsync<SearchEndpoints.SearchResultDto>(
            $"/api/groups/{groupId}/recipes/search?q=Nudeln&tags={schnell}&minRating=4");

        Assert.Equal(1, search!.Total);
        Assert.Equal(winner.Id, search.Items[0].Id);
    }

    [Fact]
    public async Task Search_403_For_Non_Member()
    {
        var (_, aTok) = await SignupAndLoginAsync("sa@ex.com", "A");
        var (_, bTok) = await SignupAndLoginAsync("sb@ex.com", "B");
        using var clientA = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientA, aTok);
        var groupId = await CreateGroupAsync(clientA);

        using var clientB = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientB, bTok);
        var response = await clientB.GetAsync($"/api/groups/{groupId}/recipes/search");
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    // ── Random ──────────────────────────────────────────────────────────

    [Fact]
    public async Task Random_With_Filter_Returns_Only_Matching_Recipes()
    {
        var (_, token) = await SignupAndLoginAsync("rn1@ex.com", "R");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);

        // 10 recipes: half match "Nudeln", half don't.
        var expected = new List<Guid>();
        for (int i = 0; i < 5; i++)
        {
            var res = await _client.PostAsJsonAsync($"/api/groups/{groupId}/recipes",
                BuildCreate($"Nudeln {i}", ingredientNames: new[] { "Nudeln" }));
            var body = (await res.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;
            expected.Add(body.Id);
        }
        for (int i = 0; i < 5; i++)
        {
            await _client.PostAsJsonAsync($"/api/groups/{groupId}/recipes",
                BuildCreate($"Pizza {i}"));
        }

        var expectedSet = expected.ToHashSet();
        for (int i = 0; i < 20; i++)
        {
            var res = await _client.GetFromJsonAsync<SearchEndpoints.RandomRecipeResponse>(
                $"/api/groups/{groupId}/recipes/random?q=Nudeln");
            Assert.NotNull(res);
            Assert.NotNull(res!.RecipeId);
            Assert.Contains(res.RecipeId!.Value, expectedSet);
        }
    }

    [Fact]
    public async Task Random_Returns_Null_RecipeId_When_No_Matches()
    {
        var (_, token) = await SignupAndLoginAsync("rn2@ex.com", "R");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);

        await _client.PostAsJsonAsync($"/api/groups/{groupId}/recipes", BuildCreate("Pizza"));

        var res = await _client.GetFromJsonAsync<SearchEndpoints.RandomRecipeResponse>(
            $"/api/groups/{groupId}/recipes/random?q=doesnotexist");
        Assert.NotNull(res);
        Assert.Null(res!.RecipeId);
    }

    [Fact]
    public async Task Random_403_For_Non_Member()
    {
        var (_, aTok) = await SignupAndLoginAsync("rna@ex.com", "A");
        var (_, bTok) = await SignupAndLoginAsync("rnb@ex.com", "B");
        using var clientA = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientA, aTok);
        var groupId = await CreateGroupAsync(clientA);

        using var clientB = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientB, bTok);
        var response = await clientB.GetAsync($"/api/groups/{groupId}/recipes/random");
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }
}
