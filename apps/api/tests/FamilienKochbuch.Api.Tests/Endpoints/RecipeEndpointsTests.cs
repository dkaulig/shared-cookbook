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
}
