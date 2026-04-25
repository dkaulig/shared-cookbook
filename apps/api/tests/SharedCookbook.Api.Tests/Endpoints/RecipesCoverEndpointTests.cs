using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using SharedCookbook.Api.Endpoints;
using SharedCookbook.Api.Tests.Infrastructure;
using SharedCookbook.Domain.Entities;
using SharedCookbook.Domain.Enums;
using SharedCookbook.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace SharedCookbook.Api.Tests.Endpoints;

/// <summary>
/// COVER-0 — end-to-end tests for <c>POST /api/recipes/:id/cover</c>.
/// The endpoint accepts either an already-promoted photo (reorder) or
/// an un-promoted candidate of the recipe's origin-import (promote +
/// swap). Other staged-photo ownership returns 400.
/// </summary>
public class RecipesCoverEndpointTests :
    IClassFixture<SharedCookbookWebApplicationFactory>, IAsyncLifetime
{
    private readonly SharedCookbookWebApplicationFactory _factory;
    private HttpClient _client = null!;

    public RecipesCoverEndpointTests(SharedCookbookWebApplicationFactory factory)
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
        db.Tags.RemoveRange(db.Tags.Where(t => t.GroupId != null));
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
    /// Seeds a recipe with N import candidates: the first is promoted
    /// onto the recipe as its cover (Photos[0]), the rest stay as
    /// un-promoted staged-photo rows linked to the same import.
    /// Mirrors the state a just-saved import leaves behind.
    /// </summary>
    private async Task<CoverSeed> SeedRecipeWithCandidatesAsync(
        Guid userId, int totalCandidates = 3)
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
            title: "Test-Rezept",
            description: "x",
            defaultServings: 2,
            prepTimeMinutes: 5,
            difficulty: 1,
            sourceUrl: "https://example.com/r",
            sourceType: RecipeSourceType.Video,
            forkOfRecipeId: null,
            createdAt: DateTimeOffset.UtcNow);
        // Minimum component for aggregate invariants.
        var comp = new RecipeComponent(recipe.Id, 0, null);
        recipe.ReplaceComponents(
            new[] { comp },
            Array.Empty<Ingredient>(),
            Array.Empty<RecipeStep>());
        db.Recipes.Add(recipe);
        await db.SaveChangesAsync();

        var import = new RecipeImport(
            userId, group.Id, ImportSource.Url,
            "https://example.com/r", DateTimeOffset.UtcNow);
        db.RecipeImports.Add(import);
        await db.SaveChangesAsync();

        var coverPath = $"recipes/cover-{recipe.Id:N}.jpg";
        _factory.Photos.Uploads[coverPath] = (new byte[] { 1, 2, 3 }, "image/jpeg");
        recipe.AddPhoto(coverPath);

        var candidateIds = new List<Guid>();
        for (int i = 0; i < totalCandidates; i++)
        {
            var path = $"recipes/cand-{import.Id:N}-{i}.jpg";
            _factory.Photos.Uploads[path] = (new byte[] { 1, 2, 3 }, "image/jpeg");
            var staged = new StagedPhoto(
                userId: userId,
                photoId: path,
                signedUrl: $"/api/photos/{path}?sig=x&exp=9",
                contentType: "image/jpeg",
                createdAt: DateTimeOffset.UtcNow,
                sourceUrl: $"https://cdn.example/thumb{i}.jpg",
                linkedImportId: import.Id,
                candidateOrder: i);
            if (i == 0)
            {
                // [0] is promoted onto the recipe as its initial cover.
                staged.MarkPromoted(recipe.Id, DateTimeOffset.UtcNow);
            }
            db.StagedPhotos.Add(staged);
            candidateIds.Add(staged.Id);
        }
        await db.SaveChangesAsync();

        return new CoverSeed(recipe.Id, coverPath, import.Id, candidateIds.ToArray());
    }

    private readonly record struct CoverSeed(
        Guid RecipeId, string OriginalCoverPath, Guid ImportId, Guid[] CandidateIds);

    [Fact]
    public async Task Anonymous_Returns_401()
    {
        var response = await _client.PostAsJsonAsync(
            $"/api/recipes/{Guid.NewGuid()}/cover",
            new RecipeEndpoints.CoverSwapRequest(Guid.NewGuid()));
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Non_Owner_Returns_403()
    {
        var (aliceId, _) = await SignupAsync("alice@ex.com", "Alice");
        var (_, bobToken) = await SignupAsync("bob@ex.com", "Bob");
        var seed = await SeedRecipeWithCandidatesAsync(aliceId);

        using var req = new HttpRequestMessage(
            HttpMethod.Post, $"/api/recipes/{seed.RecipeId}/cover");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bobToken);
        req.Content = JsonContent.Create(
            new RecipeEndpoints.CoverSwapRequest(seed.CandidateIds[1]));
        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task Happy_Path_Unpromoted_Candidate_Promotes_And_Swaps()
    {
        // Alice picks tile [1] as the new cover. Expected:
        //  - [1] gets promoted onto the recipe.
        //  - [1]'s new photo path lands at Photos[0].
        //  - The previous cover demotes to Photos[1].
        var (aliceId, aliceToken) = await SignupAsync("alice@ex.com", "Alice");
        var seed = await SeedRecipeWithCandidatesAsync(aliceId, totalCandidates: 3);

        using var req = new HttpRequestMessage(
            HttpMethod.Post, $"/api/recipes/{seed.RecipeId}/cover");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", aliceToken);
        req.Content = JsonContent.Create(
            new RecipeEndpoints.CoverSwapRequest(seed.CandidateIds[1]));
        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var recipe = await db.Recipes.SingleAsync(r => r.Id == seed.RecipeId);
        Assert.Equal(2, recipe.Photos.Count);
        // The new cover path is NOT the original cover's path — the
        // promote-flow copied the staged blob into the recipe namespace.
        Assert.NotEqual(seed.OriginalCoverPath, recipe.Photos[0]);
        // Original cover demoted to position 1.
        Assert.Equal(seed.OriginalCoverPath, recipe.Photos[1]);

        var promoted = await db.StagedPhotos
            .SingleAsync(s => s.Id == seed.CandidateIds[1]);
        Assert.NotNull(promoted.PromotedAt);
        Assert.Equal(seed.RecipeId, promoted.PromotedToRecipeId);
    }

    [Fact]
    public async Task Happy_Path_Already_Promoted_Photo_Just_Swaps()
    {
        // After a previous cover-swap Alice's recipe has 2 photos
        // (candidate[1] at [0], original at [1]). She now wants to flip
        // them back — the already-promoted row reorder-only branch
        // handles it without any new promote.
        var (aliceId, aliceToken) = await SignupAsync("alice@ex.com", "Alice");
        var seed = await SeedRecipeWithCandidatesAsync(aliceId, totalCandidates: 2);

        // Pre-step: swap to candidate[1] so the recipe has 2 promoted photos.
        using (var req = new HttpRequestMessage(
            HttpMethod.Post, $"/api/recipes/{seed.RecipeId}/cover"))
        {
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", aliceToken);
            req.Content = JsonContent.Create(
                new RecipeEndpoints.CoverSwapRequest(seed.CandidateIds[1]));
            (await _client.SendAsync(req)).EnsureSuccessStatusCode();
        }

        // Now reorder: the ORIGINAL cover's staged-photo row (which was
        // already promoted in the seed) should be acceptable as the
        // cover-swap target.
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var originalCoverStagedId = await db.StagedPhotos
            .Where(s => s.PromotedToRecipeId == seed.RecipeId
                && s.PhotoId == seed.OriginalCoverPath)
            .Select(s => s.Id)
            .SingleOrDefaultAsync();
        // The seed didn't create a StagedPhoto for the initial cover —
        // we used recipe.AddPhoto directly. Create one retroactively so
        // the reorder-only branch has a row to match.
        if (originalCoverStagedId == Guid.Empty)
        {
            var staged = new StagedPhoto(
                userId: aliceId,
                photoId: seed.OriginalCoverPath,
                signedUrl: $"/api/photos/{seed.OriginalCoverPath}?sig=x&exp=9",
                contentType: "image/jpeg",
                createdAt: DateTimeOffset.UtcNow);
            staged.MarkPromoted(seed.RecipeId, DateTimeOffset.UtcNow);
            db.StagedPhotos.Add(staged);
            await db.SaveChangesAsync();
            originalCoverStagedId = staged.Id;
        }

        using var reorderReq = new HttpRequestMessage(
            HttpMethod.Post, $"/api/recipes/{seed.RecipeId}/cover");
        reorderReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", aliceToken);
        reorderReq.Content = JsonContent.Create(
            new RecipeEndpoints.CoverSwapRequest(originalCoverStagedId));
        var response = await _client.SendAsync(reorderReq);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        using var verifyScope = _factory.Services.CreateScope();
        var verifyDb = verifyScope.ServiceProvider.GetRequiredService<AppDbContext>();
        var recipe = await verifyDb.Recipes.SingleAsync(r => r.Id == seed.RecipeId);
        Assert.Equal(seed.OriginalCoverPath, recipe.Photos[0]);
    }

    [Fact]
    public async Task StagedPhoto_Not_From_Recipe_Import_Returns_400()
    {
        // Alice owns a recipe + its import. Charlie (same user here
        // for ownership trivia) has an unrelated import's candidate —
        // the cover endpoint must refuse to promote it onto the target
        // recipe because it doesn't belong to this recipe's cohort.
        var (aliceId, aliceToken) = await SignupAsync("alice@ex.com", "Alice");
        var seed = await SeedRecipeWithCandidatesAsync(aliceId);

        // Seed an unrelated import + candidate in the SAME user's
        // scope (so ownership alone isn't the rejection reason).
        Guid strayStagedId;
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var otherGroup = new Group("H", null, DateTimeOffset.UtcNow);
            db.Groups.Add(otherGroup);
            db.GroupMemberships.Add(new GroupMembership(
                aliceId, otherGroup.Id, GroupRole.Admin, DateTimeOffset.UtcNow));
            await db.SaveChangesAsync();

            var otherImport = new RecipeImport(
                aliceId, otherGroup.Id, ImportSource.Url,
                "https://other.example/x", DateTimeOffset.UtcNow);
            db.RecipeImports.Add(otherImport);
            await db.SaveChangesAsync();

            var stray = new StagedPhoto(
                userId: aliceId,
                photoId: "recipes/stray.jpg",
                signedUrl: "/api/photos/recipes/stray.jpg?sig=x&exp=9",
                contentType: "image/jpeg",
                createdAt: DateTimeOffset.UtcNow,
                sourceUrl: "https://other.example/y.jpg",
                linkedImportId: otherImport.Id,
                candidateOrder: 0);
            _factory.Photos.Uploads[stray.PhotoId] = (new byte[] { 1 }, "image/jpeg");
            db.StagedPhotos.Add(stray);
            await db.SaveChangesAsync();
            strayStagedId = stray.Id;
        }

        using var req = new HttpRequestMessage(
            HttpMethod.Post, $"/api/recipes/{seed.RecipeId}/cover");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", aliceToken);
        req.Content = JsonContent.Create(
            new RecipeEndpoints.CoverSwapRequest(strayStagedId));
        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }
}
