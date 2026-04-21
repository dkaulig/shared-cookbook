using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using FamilienKochbuch.Api.Endpoints;
using FamilienKochbuch.Api.Jobs;
using FamilienKochbuch.Api.Tests.Infrastructure;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.Enums;
using FamilienKochbuch.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace FamilienKochbuch.Api.Tests.Endpoints;

/// <summary>
/// REIMPORT-0 — contract tests for <c>POST /api/recipes/{id}/reimport</c>.
///
/// Covers the full auth + validation staircase:
/// 401 anonymous → 404 hidden non-member / missing recipe → 400 source-url
/// gating (missing + photo-sentinel) → 409 If-Match drift → 202 happy path.
/// Happy path asserts the new <see cref="RecipeImport"/> row carries
/// <see cref="RecipeImport.TargetRecipeId"/> set to the recipe id and that
/// the Hangfire enqueue captured the expected job.
/// </summary>
public class RecipeReimportTests : IClassFixture<FamilienKochbuchWebApplicationFactory>, IAsyncLifetime
{
    private readonly FamilienKochbuchWebApplicationFactory _factory;
    private HttpClient _client = null!;

    public RecipeReimportTests(FamilienKochbuchWebApplicationFactory factory)
    {
        _factory = factory;
    }

    public async Task InitializeAsync()
    {
        _client = _factory.CreateRateLimitBypassingClient(
            new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { HandleCookies = true });
        _factory.Jobs.Reset();
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
        db.RecipeImports.RemoveRange(db.RecipeImports);
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

    private async Task<(Guid UserId, string AccessToken)> SignupAsync(string email, string displayName)
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
    /// Seeds a recipe owned by <paramref name="userId"/> in a freshly
    /// created group. Optional <paramref name="sourceUrl"/> lets tests
    /// pick between URL-imported (non-null) and manually-created (null)
    /// rows.
    ///
    /// <para>
    /// REIMPORT-0 hardening — the <see cref="Recipe"/> aggregate now
    /// rejects non-http(s) schemes at every write path. To simulate a
    /// corrupted-DB scenario (photo sentinel, <c>file://</c>,
    /// <c>javascript:</c>, …) the helper first persists the recipe with
    /// a valid placeholder URL and then issues a raw UPDATE to overwrite
    /// the column — mirroring the real drift that motivated the
    /// endpoint-level defence-in-depth guard.
    /// </para>
    /// </summary>
    private async Task<(Guid RecipeId, Guid GroupId, int Version)> SeedRecipeAsync(
        Guid userId,
        string? sourceUrl = "https://example.com/rezept",
        RecipeSourceType sourceType = RecipeSourceType.Video)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var group = new Group("ReimportGroup", null, DateTimeOffset.UtcNow);
        db.Groups.Add(group);
        await db.SaveChangesAsync();
        db.GroupMemberships.Add(new GroupMembership(userId, group.Id, GroupRole.Admin, DateTimeOffset.UtcNow));

        // Construct with a valid URL (or null) first. If the caller
        // wants to simulate a drifted DB state, we rewrite the column
        // via raw UPDATE below — the domain ctor would (correctly)
        // reject the bad scheme.
        var needsColumnRewrite =
            sourceUrl is not null
            && (!Uri.TryCreate(sourceUrl, UriKind.Absolute, out var parsed)
                || (parsed.Scheme != Uri.UriSchemeHttp && parsed.Scheme != Uri.UriSchemeHttps));
        var ctorSourceUrl = needsColumnRewrite ? "https://placeholder.invalid/x" : sourceUrl;

        var recipe = new Recipe(
            groupId: group.Id,
            createdByUserId: userId,
            title: "Original",
            description: null,
            defaultServings: 2,
            prepTimeMinutes: null,
            difficulty: 1,
            sourceUrl: ctorSourceUrl,
            sourceType: sourceType,
            forkOfRecipeId: null,
            createdAt: DateTimeOffset.UtcNow);
        db.Recipes.Add(recipe);
        await db.SaveChangesAsync();

        if (needsColumnRewrite)
        {
            await db.Recipes
                .Where(r => r.Id == recipe.Id)
                .ExecuteUpdateAsync(s => s.SetProperty(r => r.SourceUrl, sourceUrl));
        }

        return (recipe.Id, group.Id, recipe.Version);
    }

    private async Task<int> CurrentRecipeVersionAsync(Guid recipeId)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        return await db.Recipes.Where(r => r.Id == recipeId).Select(r => r.Version).SingleAsync();
    }

    [Fact]
    public async Task Anonymous_Reimport_Returns_401()
    {
        var response = await _client.PostAsync($"/api/recipes/{Guid.NewGuid()}/reimport", content: null);
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Reimport_404_When_Recipe_Missing()
    {
        var (_, token) = await SignupAsync("missing@ex.com", "M");
        _client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);

        var response = await _client.PostAsync($"/api/recipes/{Guid.NewGuid()}/reimport", content: null);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task Reimport_404_When_Caller_Not_Group_Member()
    {
        var (ownerId, _) = await SignupAsync("owner@ex.com", "O");
        var (_, otherToken) = await SignupAsync("other@ex.com", "X");
        var (recipeId, _, _) = await SeedRecipeAsync(ownerId);

        _client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", otherToken);
        var response = await _client.PostAsync($"/api/recipes/{recipeId}/reimport", content: null);

        // IDOR-hide: 404, not 403. A non-member can't distinguish the
        // recipe from a missing one.
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task Reimport_400_When_SourceUrl_Missing()
    {
        var (userId, token) = await SignupAsync("manual@ex.com", "M");
        var (recipeId, _, _) = await SeedRecipeAsync(
            userId, sourceUrl: null, sourceType: RecipeSourceType.Manual);

        _client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var response = await _client.PostAsync($"/api/recipes/{recipeId}/reimport", content: null);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<ErrorBodyDto>();
        Assert.NotNull(body);
        Assert.Equal("source_url_missing", body!.Code);
    }

    [Fact]
    public async Task Reimport_400_When_SourceUrl_Is_Photo_Sentinel()
    {
        var (userId, token) = await SignupAsync("photo@ex.com", "P");
        var (recipeId, _, _) = await SeedRecipeAsync(
            userId, sourceUrl: "photos://upload", sourceType: RecipeSourceType.Photo);

        _client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var response = await _client.PostAsync($"/api/recipes/{recipeId}/reimport", content: null);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<ErrorBodyDto>();
        Assert.NotNull(body);
        Assert.Equal("photo_import_reimport_not_supported", body!.Code);
    }

    // REIMPORT-0 hardening — the stored SourceUrl flows straight into the
    // Hangfire-enqueued Python extraction. The initial import endpoint
    // uses `TryNormalizeHttpUrl` to reject non-http(s) schemes, but the
    // PUT /api/recipes/{id} path currently validates only length on the
    // URL column, so a caller with edit rights could have persisted a
    // `file://` / `javascript:` / `gopher://` URL before triggering
    // reimport. Defence-in-depth: refuse non-http(s) at the reimport
    // enqueue point so a drifted DB value cannot redirect the extractor
    // at an internal / exotic target.
    [Theory]
    [InlineData("file:///etc/passwd")]
    [InlineData("gopher://127.0.0.1:25/xSMTP%20HELO%20attacker.example")]
    [InlineData("javascript:alert(1)")]
    [InlineData("ftp://example.com/rezept")]
    public async Task Reimport_400_When_Stored_SourceUrl_Has_Non_Http_Scheme(string storedUrl)
    {
        var (userId, token) = await SignupAsync($"badscheme-{Guid.NewGuid():N}@ex.com", "B");
        var (recipeId, _, _) = await SeedRecipeAsync(userId, sourceUrl: storedUrl);

        _client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var response = await _client.PostAsync($"/api/recipes/{recipeId}/reimport", content: null);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<ErrorBodyDto>();
        Assert.NotNull(body);
        Assert.Equal("invalid_source_url", body!.Code);

        // No job was enqueued — the guard rejects before Hangfire is asked
        // to run the Python extractor against the suspicious URL.
        Assert.Empty(_factory.Jobs.Created);
    }

    [Fact]
    public async Task Reimport_409_On_Stale_If_Match()
    {
        var (userId, token) = await SignupAsync("stale@ex.com", "S");
        var (recipeId, _, version) = await SeedRecipeAsync(userId);

        _client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);

        using var req = new HttpRequestMessage(HttpMethod.Post, $"/api/recipes/{recipeId}/reimport");
        // version-1 is guaranteed to be stale (current is `version`, a
        // non-negative int that starts at 0 on a fresh seed — we pick a
        // value that cannot match).
        req.Headers.TryAddWithoutValidation("If-Match", $"W/\"{recipeId:D}-{version + 99}\"");
        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<ErrorBodyDto>();
        Assert.NotNull(body);
        Assert.Equal("version_mismatch", body!.Code);
    }

    [Fact]
    public async Task Reimport_202_Happy_Path_Creates_Import_Row_With_TargetRecipeId_Set()
    {
        var (userId, token) = await SignupAsync("happy@ex.com", "H");
        var (recipeId, groupId, _) = await SeedRecipeAsync(userId);

        _client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var response = await _client.PostAsync($"/api/recipes/{recipeId}/reimport", content: null);

        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<ImportEndpoints.ImportEnqueueResponse>();
        Assert.NotNull(body);
        Assert.NotEqual(Guid.Empty, body!.ImportId);

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var import = await db.RecipeImports.AsNoTracking().SingleAsync(i => i.Id == body.ImportId);
        Assert.Equal(recipeId, import.TargetRecipeId);
        Assert.Equal(ImportSource.Url, import.Source);
        Assert.Equal(ImportStatus.Queued, import.Status);
        Assert.Equal(groupId, import.GroupId);
        Assert.Equal("https://example.com/rezept", import.SourceUrl);
        Assert.Equal(userId, import.UserId);

        // Hangfire enqueue captured by the test double — exactly one
        // ExtractRecipeFromUrlJob.ExecuteAsync call with the new
        // importId as the first argument.
        var captured = Assert.Single(_factory.Jobs.Created);
        Assert.Equal(nameof(ExtractRecipeFromUrlJob.ExecuteAsync), captured.Job.Method.Name);
        Assert.Equal(typeof(ExtractRecipeFromUrlJob), captured.Job.Type);
        Assert.Equal(body.ImportId, (Guid)captured.Job.Args[0]!);
    }

    [Fact]
    public async Task Reimport_With_Matching_If_Match_Succeeds()
    {
        var (userId, token) = await SignupAsync("ifmatch-ok@ex.com", "K");
        var (recipeId, _, version) = await SeedRecipeAsync(userId);

        _client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);

        using var req = new HttpRequestMessage(HttpMethod.Post, $"/api/recipes/{recipeId}/reimport");
        req.Headers.TryAddWithoutValidation("If-Match", $"W/\"{recipeId:D}-{version}\"");
        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
    }

    private sealed record ErrorBodyDto(string Code, string Message);
}
