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
/// End-to-end tests for the S4 Rating endpoints. Upsert semantics, RBAC
/// via group membership, validation of the 1..5 star range, aggregate
/// (avg/count) correctness, and list ordering.
/// </summary>
public class RatingEndpointsTests : IClassFixture<FamilienKochbuchWebApplicationFactory>, IAsyncLifetime
{
    private readonly FamilienKochbuchWebApplicationFactory _factory;
    private HttpClient _client = null!;

    public RatingEndpointsTests(FamilienKochbuchWebApplicationFactory factory)
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

    private static RecipeEndpoints.CreateRecipeRequest BuildCreate(string title = "Spätzle")
        => new(
            Title: title,
            Description: null,
            DefaultServings: 4,
            PrepTimeMinutes: 30,
            Difficulty: 1,
            SourceUrl: null,
            Components: new[]
            {
                new RecipeEndpoints.RecipeComponentRequest(
                    Position: 0,
                    Label: null,
                    Ingredients: new[] { new RecipeEndpoints.IngredientRequest(0, 500m, "g", "Mehl", null, true) },
                    Steps: new[] { new RecipeEndpoints.StepRequest(0, "Kochen.") }),
            },
            TagIds: Array.Empty<Guid>());

    private async Task<Guid> CreateRecipeAsync(HttpClient client, Guid groupId, string title = "Spätzle")
    {
        var res = await client.PostAsJsonAsync($"/api/groups/{groupId}/recipes", BuildCreate(title));
        res.EnsureSuccessStatusCode();
        var body = (await res.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeDetailDto>())!;
        return body.Id;
    }

    // ── POST /api/recipes/{id}/ratings ──────────────────────────────────

    [Fact]
    public async Task PostRating_Creates_New_Rating_And_Returns_Aggregate()
    {
        var (_, token) = await SignupAndLoginAsync("r1@ex.com", "Rater");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await CreateRecipeAsync(_client, groupId);

        var response = await _client.PostAsJsonAsync($"/api/recipes/{recipeId}/ratings",
            new RatingEndpoints.UpsertRatingRequest(5, "Lecker!"));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = (await response.Content.ReadFromJsonAsync<RatingEndpoints.UpsertRatingResponse>())!;
        Assert.Equal(5, body.Rating.Stars);
        Assert.Equal("Lecker!", body.Rating.Comment);
        Assert.Equal(5.0, body.Aggregate.Avg);
        Assert.Equal(1, body.Aggregate.Count);
        Assert.Equal(5, body.Aggregate.MyStars);
    }

    [Fact]
    public async Task PostRating_Is_Upsert_For_Same_User()
    {
        var (_, token) = await SignupAndLoginAsync("r2@ex.com", "Rater");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await CreateRecipeAsync(_client, groupId);

        var first = await _client.PostAsJsonAsync($"/api/recipes/{recipeId}/ratings",
            new RatingEndpoints.UpsertRatingRequest(5, "super"));
        first.EnsureSuccessStatusCode();

        var second = await _client.PostAsJsonAsync($"/api/recipes/{recipeId}/ratings",
            new RatingEndpoints.UpsertRatingRequest(3, "doch nur mittel"));
        second.EnsureSuccessStatusCode();
        var body = (await second.Content.ReadFromJsonAsync<RatingEndpoints.UpsertRatingResponse>())!;

        Assert.Equal(3, body.Rating.Stars);
        Assert.Equal(3.0, body.Aggregate.Avg);
        Assert.Equal(1, body.Aggregate.Count);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(6)]
    [InlineData(-1)]
    public async Task PostRating_400_On_Stars_Out_Of_Range(int invalid)
    {
        var (_, token) = await SignupAndLoginAsync($"rv{invalid}@ex.com", "Rater");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await CreateRecipeAsync(_client, groupId);

        var response = await _client.PostAsJsonAsync($"/api/recipes/{recipeId}/ratings",
            new RatingEndpoints.UpsertRatingRequest(invalid, null));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task PostRating_403_For_Non_Member()
    {
        var (_, aTok) = await SignupAndLoginAsync("ra@ex.com", "A");
        var (_, bTok) = await SignupAndLoginAsync("rb@ex.com", "B");
        using var clientA = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientA, aTok);
        var groupId = await CreateGroupAsync(clientA);
        var recipeId = await CreateRecipeAsync(clientA, groupId);

        using var clientB = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientB, bTok);
        var response = await clientB.PostAsJsonAsync($"/api/recipes/{recipeId}/ratings",
            new RatingEndpoints.UpsertRatingRequest(5, null));
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task PostRating_401_When_Unauthenticated()
    {
        var response = await _client.PostAsJsonAsync($"/api/recipes/{Guid.NewGuid()}/ratings",
            new RatingEndpoints.UpsertRatingRequest(4, null));
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    // ── DELETE /api/recipes/{id}/ratings ────────────────────────────────

    [Fact]
    public async Task DeleteRating_Removes_User_Rating_And_Updates_Aggregate()
    {
        var (_, token) = await SignupAndLoginAsync("rd@ex.com", "D");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await CreateRecipeAsync(_client, groupId);

        var post = await _client.PostAsJsonAsync($"/api/recipes/{recipeId}/ratings",
            new RatingEndpoints.UpsertRatingRequest(5, null));
        post.EnsureSuccessStatusCode();

        var del = await _client.DeleteAsync($"/api/recipes/{recipeId}/ratings");
        Assert.Equal(HttpStatusCode.NoContent, del.StatusCode);

        var list = await _client.GetFromJsonAsync<RatingEndpoints.RatingListResponse>(
            $"/api/recipes/{recipeId}/ratings");
        Assert.Equal(0, list!.Aggregate.Count);
        Assert.Null(list.Aggregate.Avg);
        Assert.Null(list.Aggregate.MyStars);
    }

    [Fact]
    public async Task DeleteRating_204_When_No_Rating_Exists()
    {
        var (_, token) = await SignupAndLoginAsync("rdn@ex.com", "N");
        AuthorizeClient(_client, token);
        var groupId = await CreateGroupAsync(_client);
        var recipeId = await CreateRecipeAsync(_client, groupId);

        var del = await _client.DeleteAsync($"/api/recipes/{recipeId}/ratings");
        Assert.Equal(HttpStatusCode.NoContent, del.StatusCode);
    }

    // ── GET /api/recipes/{id}/ratings ───────────────────────────────────

    [Fact]
    public async Task GetRatings_Lists_All_With_Aggregate_And_Sorted_By_UpdatedAt()
    {
        var (aliceId, aTok) = await SignupAndLoginAsync("alice-r@ex.com", "Alice");
        var (bobId, bTok) = await SignupAndLoginAsync("bob-r@ex.com", "Bob");
        using var alice = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(alice, aTok);
        using var bob = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(bob, bTok);

        var groupId = await CreateGroupAsync(alice);
        // invite Bob
        using var search = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(search, aTok);
        var inviteRes = await alice.PostAsJsonAsync($"/api/groups/{groupId}/invites",
            new GroupEndpoints.InviteToGroupRequest(bobId));
        inviteRes.EnsureSuccessStatusCode();
        var invite = (await inviteRes.Content.ReadFromJsonAsync<GroupEndpoints.GroupInviteDto>())!;
        var accept = await bob.PostAsync($"/api/groups/invites/{invite.Id}/accept", null);
        accept.EnsureSuccessStatusCode();

        var recipeId = await CreateRecipeAsync(alice, groupId);

        // Alice rates first, then Bob (whose UpdatedAt is newer). The
        // FakeTimeProvider is the single authoritative clock; nudging it by
        // a few seconds between writes is enough to distinguish UpdatedAt
        // timestamps without drifting past JwtBearer's real-time ClockSkew
        // (30s) — keeping Bob's access token valid.
        (await alice.PostAsJsonAsync($"/api/recipes/{recipeId}/ratings",
            new RatingEndpoints.UpsertRatingRequest(4, "prima"))).EnsureSuccessStatusCode();
        _factory.Clock.Advance(TimeSpan.FromSeconds(5));
        (await bob.PostAsJsonAsync($"/api/recipes/{recipeId}/ratings",
            new RatingEndpoints.UpsertRatingRequest(2, "nicht so meins"))).EnsureSuccessStatusCode();

        var list = await alice.GetFromJsonAsync<RatingEndpoints.RatingListResponse>(
            $"/api/recipes/{recipeId}/ratings");
        Assert.Equal(2, list!.Aggregate.Count);
        Assert.Equal(3.0, list.Aggregate.Avg);
        Assert.Equal(2, list.Ratings.Length);
        // Newest update first.
        Assert.Equal(bobId, list.Ratings[0].UserId);
        Assert.Equal(aliceId, list.Ratings[1].UserId);
        // MyStars for Alice:
        Assert.Equal(4, list.Aggregate.MyStars);
    }

    [Fact]
    public async Task GetRatings_403_For_Non_Member()
    {
        var (_, aTok) = await SignupAndLoginAsync("gra@ex.com", "A");
        var (_, bTok) = await SignupAndLoginAsync("grb@ex.com", "B");
        using var clientA = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientA, aTok);
        var groupId = await CreateGroupAsync(clientA);
        var recipeId = await CreateRecipeAsync(clientA, groupId);

        using var clientB = _factory.CreateRateLimitBypassingClient();
        AuthorizeClient(clientB, bTok);
        var response = await clientB.GetAsync($"/api/recipes/{recipeId}/ratings");
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }
}
