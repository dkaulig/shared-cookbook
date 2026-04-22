using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using FamilienKochbuch.Api.Endpoints;
using FamilienKochbuch.Api.Tests.Infrastructure;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.Enums;
using FamilienKochbuch.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace FamilienKochbuch.Api.Tests.Endpoints;

/// <summary>
/// COVER-0 Slice E — tests for <c>GET /api/recipes/:id/origin-import</c>.
///
/// The endpoint returns the <see cref="RecipeImport"/> id that produced
/// this recipe (so the frontend can mount the "Cover ändern" modal
/// without threading the importId through client-side state that was
/// already torn down post-save). Derivation order on the server:
/// <list type="number">
/// <item>Any <see cref="StagedPhoto"/> already promoted onto the recipe
/// whose <c>LinkedImportId</c> is non-null — that's the import the cover
/// came from.</item>
/// <item>Fallback: a <see cref="RecipeImport"/> whose
/// <c>TargetRecipeId</c> equals the recipe id (reimport path where the
/// [0] candidate was demoted / removed).</item>
/// </list>
///
/// Returns 200 with <c>{ importId }</c> on a match, 404 when no import
/// linkage exists (manual recipe / sweep-reaped candidates all gone +
/// not a reimport), 403 when the caller isn't the recipe owner, 401
/// anonymous.
/// </summary>
public class RecipeOriginImportEndpointTests :
    IClassFixture<FamilienKochbuchWebApplicationFactory>, IAsyncLifetime
{
    private readonly FamilienKochbuchWebApplicationFactory _factory;
    private HttpClient _client = null!;

    public RecipeOriginImportEndpointTests(FamilienKochbuchWebApplicationFactory factory)
    {
        _factory = factory;
    }

    public async Task InitializeAsync()
    {
        _client = _factory.CreateRateLimitBypassingClient(
            new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { HandleCookies = true });
        _factory.Photos.Clear();
        await ResetAsync();
    }

    public Task DisposeAsync()
    {
        _client.Dispose();
        return Task.CompletedTask;
    }

    private async Task ResetAsync()
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        db.Ingredients.RemoveRange(db.Ingredients);
        db.RecipeSteps.RemoveRange(db.RecipeSteps);
        db.RecipeComponents.RemoveRange(db.RecipeComponents);
        db.RecipeTags.RemoveRange(db.RecipeTags);
        db.StagedPhotos.RemoveRange(db.StagedPhotos);
        db.RecipeImports.RemoveRange(db.RecipeImports);
        db.Recipes.RemoveRange(db.Recipes);
        db.GroupMemberships.RemoveRange(db.GroupMemberships);
        db.Groups.RemoveRange(db.Groups);
        db.RefreshTokens.RemoveRange(db.RefreshTokens);
        db.AppInvites.RemoveRange(db.AppInvites);
        var nonAdmin = db.Users.Where(u => u.Email != "admin@test.local");
        db.Users.RemoveRange(nonAdmin);
        await db.SaveChangesAsync();
    }

    private async Task<(Guid userId, string token)> SignupAsync(string email, string displayName)
    {
        var adminToken = (await LoginAsync("admin@test.local", "AdminPassword123!")).AccessToken;
        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/invites/app/");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", adminToken);
        req.Content = JsonContent.Create(new { });
        var inviteRes = await _client.SendAsync(req);
        inviteRes.EnsureSuccessStatusCode();
        var invite = await inviteRes.Content.ReadFromJsonAsync<InviteEndpoints.CreateInviteResponse>();

        using var fresh = _factory.CreateRateLimitBypassingClient(
            new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { HandleCookies = true });
        var signup = await fresh.PostAsJsonAsync(
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

    /// <summary>
    /// Seeds a recipe + import + N staged photos; the [0] candidate is
    /// already promoted onto the recipe as its cover, with
    /// <c>LinkedImportId</c> set. Mirrors what a just-saved URL-import
    /// flow leaves behind.
    /// </summary>
    private async Task<Seed> SeedRecipeViaImportAsync(Guid userId, int totalCandidates = 2)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var group = new Group("G", null, DateTimeOffset.UtcNow);
        db.Groups.Add(group);
        db.GroupMemberships.Add(
            new GroupMembership(userId, group.Id, GroupRole.Admin, DateTimeOffset.UtcNow));
        await db.SaveChangesAsync();

        var recipe = new Recipe(
            groupId: group.Id,
            createdByUserId: userId,
            title: "R",
            description: null,
            defaultServings: 2,
            prepTimeMinutes: null,
            difficulty: 1,
            sourceUrl: "https://example.com/r",
            sourceType: RecipeSourceType.Video,
            forkOfRecipeId: null,
            createdAt: DateTimeOffset.UtcNow);
        var comp = new RecipeComponent(recipe.Id, 0, null);
        recipe.ReplaceComponents(
            new[] { comp }, Array.Empty<Ingredient>(), Array.Empty<RecipeStep>());
        db.Recipes.Add(recipe);
        await db.SaveChangesAsync();

        var import = new RecipeImport(
            userId, group.Id, ImportSource.Url,
            "https://example.com/r", DateTimeOffset.UtcNow);
        db.RecipeImports.Add(import);
        await db.SaveChangesAsync();

        for (int i = 0; i < totalCandidates; i++)
        {
            var path = $"recipes/c-{import.Id:N}-{i}.jpg";
            _factory.Photos.Uploads[path] = (new byte[] { 1 }, "image/jpeg");
            var staged = new StagedPhoto(
                userId: userId,
                photoId: path,
                signedUrl: $"/api/photos/{path}?sig=x&exp=9",
                contentType: "image/jpeg",
                createdAt: DateTimeOffset.UtcNow,
                sourceUrl: $"https://cdn.example/t{i}.jpg",
                linkedImportId: import.Id,
                candidateOrder: i);
            if (i == 0)
            {
                recipe.AddPhoto(path);
                staged.MarkPromoted(recipe.Id, DateTimeOffset.UtcNow);
            }
            db.StagedPhotos.Add(staged);
        }
        await db.SaveChangesAsync();

        return new Seed(recipe.Id, import.Id);
    }

    private readonly record struct Seed(Guid RecipeId, Guid ImportId);

    [Fact]
    public async Task Anonymous_Returns_401()
    {
        var response = await _client.GetAsync(
            $"/api/recipes/{Guid.NewGuid()}/origin-import");
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Non_Owner_Returns_403()
    {
        var (aliceId, _) = await SignupAsync("alice@ex.com", "Alice");
        var (_, bobToken) = await SignupAsync("bob@ex.com", "Bob");
        var seed = await SeedRecipeViaImportAsync(aliceId);

        using var req = new HttpRequestMessage(
            HttpMethod.Get, $"/api/recipes/{seed.RecipeId}/origin-import");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bobToken);
        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task Missing_Recipe_Returns_404()
    {
        var (_, token) = await SignupAsync("alice@ex.com", "Alice");
        using var req = new HttpRequestMessage(
            HttpMethod.Get, $"/api/recipes/{Guid.NewGuid()}/origin-import");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task Recipe_From_Import_Returns_200_With_ImportId()
    {
        var (aliceId, aliceToken) = await SignupAsync("alice@ex.com", "Alice");
        var seed = await SeedRecipeViaImportAsync(aliceId);

        using var req = new HttpRequestMessage(
            HttpMethod.Get, $"/api/recipes/{seed.RecipeId}/origin-import");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", aliceToken);
        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content
            .ReadFromJsonAsync<RecipeEndpoints.RecipeOriginImportResponse>();
        Assert.NotNull(body);
        Assert.Equal(seed.ImportId, body!.ImportId);
    }

    [Fact]
    public async Task Manual_Recipe_Without_Import_Returns_404()
    {
        // A recipe created manually has no StagedPhotos linked to an
        // import and no RecipeImport.TargetRecipeId pointing at it.
        var (aliceId, aliceToken) = await SignupAsync("alice@ex.com", "Alice");
        Guid recipeId;
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var group = new Group("G", null, DateTimeOffset.UtcNow);
            db.Groups.Add(group);
            db.GroupMemberships.Add(new GroupMembership(
                aliceId, group.Id, GroupRole.Admin, DateTimeOffset.UtcNow));
            await db.SaveChangesAsync();

            var recipe = new Recipe(
                groupId: group.Id,
                createdByUserId: aliceId,
                title: "Manual", description: null,
                defaultServings: 2, prepTimeMinutes: null, difficulty: 1,
                sourceUrl: null, sourceType: RecipeSourceType.Manual,
                forkOfRecipeId: null, createdAt: DateTimeOffset.UtcNow);
            var comp = new RecipeComponent(recipe.Id, 0, null);
            recipe.ReplaceComponents(
                new[] { comp }, Array.Empty<Ingredient>(), Array.Empty<RecipeStep>());
            db.Recipes.Add(recipe);
            await db.SaveChangesAsync();
            recipeId = recipe.Id;
        }

        using var req = new HttpRequestMessage(
            HttpMethod.Get, $"/api/recipes/{recipeId}/origin-import");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", aliceToken);
        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task Reimport_Path_Uses_TargetRecipeId_Fallback()
    {
        // A reimport path's candidate rows may not be promoted onto the
        // recipe (the user only saved the new metadata, not the new
        // candidate). The endpoint still resolves the originating import
        // via RecipeImport.TargetRecipeId.
        var (aliceId, aliceToken) = await SignupAsync("alice@ex.com", "Alice");

        Guid recipeId;
        Guid importId;
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var group = new Group("G", null, DateTimeOffset.UtcNow);
            db.Groups.Add(group);
            db.GroupMemberships.Add(new GroupMembership(
                aliceId, group.Id, GroupRole.Admin, DateTimeOffset.UtcNow));
            await db.SaveChangesAsync();

            var recipe = new Recipe(
                groupId: group.Id,
                createdByUserId: aliceId,
                title: "Reimported", description: null,
                defaultServings: 2, prepTimeMinutes: null, difficulty: 1,
                sourceUrl: "https://example.com/r",
                sourceType: RecipeSourceType.Video,
                forkOfRecipeId: null, createdAt: DateTimeOffset.UtcNow);
            var comp = new RecipeComponent(recipe.Id, 0, null);
            recipe.ReplaceComponents(
                new[] { comp }, Array.Empty<Ingredient>(), Array.Empty<RecipeStep>());
            db.Recipes.Add(recipe);
            await db.SaveChangesAsync();
            recipeId = recipe.Id;

            var import = new RecipeImport(
                aliceId, group.Id, ImportSource.Url,
                "https://example.com/r", DateTimeOffset.UtcNow,
                targetRecipeId: recipe.Id);
            db.RecipeImports.Add(import);
            await db.SaveChangesAsync();
            importId = import.Id;

            // Un-promoted candidates linked to the reimport, matching the
            // post-Slice-B CandidateAttacher outputs. Note no StagedPhoto
            // is promoted onto the recipe — the recipe carries no photos
            // yet (or only one from the prior import).
            var staged = new StagedPhoto(
                userId: aliceId,
                photoId: $"recipes/reimp-{import.Id:N}-0.jpg",
                signedUrl: $"/api/photos/reimp.jpg?sig=x&exp=9",
                contentType: "image/jpeg",
                createdAt: DateTimeOffset.UtcNow,
                sourceUrl: "https://cdn.example/reimp.jpg",
                linkedImportId: import.Id,
                candidateOrder: 0);
            db.StagedPhotos.Add(staged);
            await db.SaveChangesAsync();
        }

        using var req = new HttpRequestMessage(
            HttpMethod.Get, $"/api/recipes/{recipeId}/origin-import");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", aliceToken);
        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content
            .ReadFromJsonAsync<RecipeEndpoints.RecipeOriginImportResponse>();
        Assert.NotNull(body);
        Assert.Equal(importId, body!.ImportId);
    }
}
