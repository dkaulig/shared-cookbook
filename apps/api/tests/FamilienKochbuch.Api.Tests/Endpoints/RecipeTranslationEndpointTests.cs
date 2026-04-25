using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using FamilienKochbuch.Api.Endpoints;
using FamilienKochbuch.Api.Tests.Infrastructure;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.Enums;
using FamilienKochbuch.Infrastructure.Persistence;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace FamilienKochbuch.Api.Tests.Endpoints;

/// <summary>
/// LANG-2 — integration tests for <c>POST /api/recipes/:id/translate</c>.
///
/// Wires the endpoint against a SQLite in-memory DbContext (via the
/// shared <see cref="FamilienKochbuchWebApplicationFactory"/>) and a
/// scripted <see cref="FakeAzureOpenAIChatClient"/> so the LLM call is
/// deterministic. Covers auth + group-membership gates, same-language
/// rejection, cache flow, force-refresh, LLM error paths and the
/// stale-cascade triggered by PUT /api/recipes/:id.
/// </summary>
public class RecipeTranslationEndpointTests
    : IClassFixture<FamilienKochbuchWebApplicationFactory>, IAsyncLifetime
{
    private readonly FamilienKochbuchWebApplicationFactory _factory;
    private HttpClient _client = null!;

    public RecipeTranslationEndpointTests(FamilienKochbuchWebApplicationFactory factory)
    {
        _factory = factory;
    }

    public async Task InitializeAsync()
    {
        await ResetDatabaseAsync();
        _client = _factory.CreateRateLimitBypassingClient();
        _factory.AzureOpenAi.Reset();
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
        db.RecipeTranslations.RemoveRange(db.RecipeTranslations);
        db.RecipeTags.RemoveRange(db.RecipeTags);
        db.Ingredients.RemoveRange(db.Ingredients);
        db.RecipeSteps.RemoveRange(db.RecipeSteps);
        db.RecipeComponents.RemoveRange(db.RecipeComponents);
        db.Recipes.RemoveRange(db.Recipes);
        db.GroupMemberships.RemoveRange(db.GroupMemberships);
        db.Groups.RemoveRange(db.Groups);
        db.RefreshTokens.RemoveRange(db.RefreshTokens);
        db.AppInvites.RemoveRange(db.AppInvites);
        var nonAdmin = db.Users.Where(u => u.Email != "admin@test.local");
        db.Users.RemoveRange(nonAdmin);
        await db.SaveChangesAsync();
    }

    // ── helpers ─────────────────────────────────────────────────────

    private async Task<(Guid UserId, string Token)> SignupAndLoginAsync(
        string email, string displayName)
    {
        var adminLogin = await LoginAsync("admin@test.local", "AdminPassword123!");
        using var inviteReq = new HttpRequestMessage(HttpMethod.Post, "/api/invites/app/");
        inviteReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", adminLogin.AccessToken);
        inviteReq.Content = JsonContent.Create(new { });
        var inviteRes = await _client.SendAsync(inviteReq);
        inviteRes.EnsureSuccessStatusCode();
        var invite = (await inviteRes.Content.ReadFromJsonAsync<InviteEndpoints.CreateInviteResponse>())!;

        using var fresh = _factory.CreateRateLimitBypassingClient(
            new WebApplicationFactoryClientOptions { HandleCookies = true });
        var signup = await fresh.PostAsJsonAsync(
            $"/api/auth/signup?token={invite.Token}",
            new AuthEndpoints.SignupRequest(email, "Passwort123!", displayName));
        signup.EnsureSuccessStatusCode();
        var body = (await signup.Content.ReadFromJsonAsync<AuthEndpoints.AuthResponse>())!;
        return (body.User.Id, body.AccessToken);
    }

    private async Task<AuthEndpoints.AuthResponse> LoginAsync(string email, string password)
    {
        using var client = _factory.CreateRateLimitBypassingClient(
            new WebApplicationFactoryClientOptions { HandleCookies = true });
        var response = await client.PostAsJsonAsync("/api/auth/login",
            new AuthEndpoints.LoginRequest(email, password));
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadFromJsonAsync<AuthEndpoints.AuthResponse>())!;
    }

    private async Task<Guid> CreateGroupAsync(string name = "Test-Gruppe")
    {
        var create = await _client.PostAsJsonAsync("/api/groups",
            new GroupEndpoints.CreateGroupRequest(name, null, null));
        create.EnsureSuccessStatusCode();
        var body = (await create.Content.ReadFromJsonAsync<GroupEndpoints.GroupSummaryDto>())!;
        return body.Id;
    }

    /// <summary>
    /// Seeds a recipe with the requested <paramref name="sourceLanguage"/>
    /// inserted directly through the domain ctor (so we don't depend on
    /// the create-endpoint's Accept-Language interpretation). Returns
    /// the recipe id so the test can hit POST /translate against it.
    /// </summary>
    private async Task<Guid> SeedRecipeWithSourceLanguageAsync(
        Guid groupId, Guid userId, string sourceLanguage)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var recipe = new Recipe(
            groupId: groupId,
            createdByUserId: userId,
            title: sourceLanguage == "de" ? "Spätzle" : "Spaetzle",
            description: sourceLanguage == "de" ? "Schwäbisch." : "Swabian.",
            defaultServings: 4,
            prepTimeMinutes: 30,
            difficulty: 1,
            sourceUrl: null,
            sourceType: RecipeSourceType.Manual,
            forkOfRecipeId: null,
            createdAt: DateTimeOffset.UtcNow,
            sourceLanguage: sourceLanguage);
        var component = new RecipeComponent(recipe.Id, 0, null);
        var ingredient = new Ingredient(
            recipeId: recipe.Id,
            componentId: component.Id,
            position: 0,
            quantity: 500m,
            unit: "g",
            name: sourceLanguage == "de" ? "Mehl" : "Flour",
            note: null,
            scalable: true);
        var step = new RecipeStep(
            recipeId: recipe.Id,
            componentId: component.Id,
            position: 0,
            content: sourceLanguage == "de" ? "Mehl sieben." : "Sift the flour.");
        recipe.ReplaceComponents(
            new[] { component },
            new[] { ingredient },
            new[] { step });
        db.Recipes.Add(recipe);
        await db.SaveChangesAsync();
        return recipe.Id;
    }

    private const string ValidTranslationJson =
        "{\"title\":\"Spaetzle\",\"description\":\"Swabian.\","
        + "\"components\":[],\"tags\":[]}";

    private void Authorise(string token) =>
        _client.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", token);

    // ── Tests ───────────────────────────────────────────────────────

    [Fact]
    public async Task Translate_401_When_Unauthenticated()
    {
        var response = await _client.PostAsync(
            $"/api/recipes/{Guid.NewGuid()}/translate?lang=en", content: null);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Translate_400_When_Lang_Param_Missing()
    {
        var (userId, token) = await SignupAndLoginAsync("missing-lang@ex.com", "M");
        Authorise(token);
        var groupId = await CreateGroupAsync();
        var recipeId = await SeedRecipeWithSourceLanguageAsync(groupId, userId, "de");

        var response = await _client.PostAsync(
            $"/api/recipes/{recipeId}/translate", content: null);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Theory]
    [InlineData("xx")]
    [InlineData("fr")]
    [InlineData("de-DE")]
    public async Task Translate_400_When_Lang_Param_Invalid(string lang)
    {
        var (userId, token) = await SignupAndLoginAsync(
            $"bad-lang-{Guid.NewGuid():N}@ex.com", "B");
        Authorise(token);
        var groupId = await CreateGroupAsync();
        var recipeId = await SeedRecipeWithSourceLanguageAsync(groupId, userId, "de");

        var response = await _client.PostAsync(
            $"/api/recipes/{recipeId}/translate?lang={lang}", content: null);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Translate_404_When_Recipe_Missing()
    {
        var (_, token) = await SignupAndLoginAsync("missing-recipe@ex.com", "MR");
        Authorise(token);

        var response = await _client.PostAsync(
            $"/api/recipes/{Guid.NewGuid()}/translate?lang=en", content: null);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task Translate_403_When_Not_Group_Member()
    {
        var (ownerId, ownerTok) = await SignupAndLoginAsync("owner@ex.com", "Owner");
        Authorise(ownerTok);
        var ownerGroupId = await CreateGroupAsync("Owner-Gruppe");
        var recipeId = await SeedRecipeWithSourceLanguageAsync(ownerGroupId, ownerId, "de");

        // Different user, not a member of ownerGroupId
        var (_, intruderTok) = await SignupAndLoginAsync("intruder@ex.com", "Intruder");
        using var intruderClient = _factory.CreateRateLimitBypassingClient();
        intruderClient.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", intruderTok);

        var response = await intruderClient.PostAsync(
            $"/api/recipes/{recipeId}/translate?lang=en", content: null);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task Translate_400_AlreadyInLanguage_When_Target_Equals_Source()
    {
        var (userId, token) = await SignupAndLoginAsync("same-lang@ex.com", "S");
        Authorise(token);
        var groupId = await CreateGroupAsync();
        var recipeId = await SeedRecipeWithSourceLanguageAsync(groupId, userId, "de");

        var response = await _client.PostAsync(
            $"/api/recipes/{recipeId}/translate?lang=de", content: null);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.Equal("already_in_language",
            body.RootElement.GetProperty("code").GetString());
    }

    [Fact]
    public async Task Translate_Cache_Miss_Calls_Llm_And_Persists()
    {
        var (userId, token) = await SignupAndLoginAsync("miss@ex.com", "MM");
        Authorise(token);
        var groupId = await CreateGroupAsync();
        var recipeId = await SeedRecipeWithSourceLanguageAsync(groupId, userId, "de");
        _factory.AzureOpenAi.SetTitle(ValidTranslationJson);

        var response = await _client.PostAsync(
            $"/api/recipes/{recipeId}/translate?lang=en", content: null);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = (await response.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeTranslationResponseDto>())!;
        Assert.Equal(recipeId, body.RecipeId);
        Assert.Equal("en", body.Language);
        Assert.False(body.IsStale);
        Assert.False(body.CacheHit);
        Assert.Equal(ValidTranslationJson, body.TranslatedPayload);
        Assert.Single(_factory.AzureOpenAi.CompleteCalls);

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var stored = await db.RecipeTranslations.AsNoTracking()
            .SingleAsync(t => t.RecipeId == recipeId && t.Language == "en");
        Assert.False(stored.IsStale);
        Assert.Equal(ValidTranslationJson, stored.TranslatedPayload);
    }

    [Fact]
    public async Task Translate_Cache_Hit_Skips_Llm()
    {
        var (userId, token) = await SignupAndLoginAsync("hit@ex.com", "H");
        Authorise(token);
        var groupId = await CreateGroupAsync();
        var recipeId = await SeedRecipeWithSourceLanguageAsync(groupId, userId, "de");
        _factory.AzureOpenAi.SetTitle(ValidTranslationJson);

        await _client.PostAsync($"/api/recipes/{recipeId}/translate?lang=en", null);
        Assert.Single(_factory.AzureOpenAi.CompleteCalls);

        var second = await _client.PostAsync(
            $"/api/recipes/{recipeId}/translate?lang=en", content: null);
        Assert.Equal(HttpStatusCode.OK, second.StatusCode);
        var body = (await second.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeTranslationResponseDto>())!;
        Assert.True(body.CacheHit);
        Assert.False(body.IsStale);
        Assert.Single(_factory.AzureOpenAi.CompleteCalls);
    }

    [Fact]
    public async Task Translate_Stale_Without_Force_Serves_Stale_Without_Llm()
    {
        var (userId, token) = await SignupAndLoginAsync("stale@ex.com", "ST");
        Authorise(token);
        var groupId = await CreateGroupAsync();
        var recipeId = await SeedRecipeWithSourceLanguageAsync(groupId, userId, "de");
        _factory.AzureOpenAi.SetTitle(ValidTranslationJson);

        await _client.PostAsync($"/api/recipes/{recipeId}/translate?lang=en", null);
        Assert.Single(_factory.AzureOpenAi.CompleteCalls);

        // Simulate a recipe edit that flipped the stale flag
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var t = await db.RecipeTranslations
                .SingleAsync(x => x.RecipeId == recipeId && x.Language == "en");
            t.MarkStale();
            await db.SaveChangesAsync();
        }

        var response = await _client.PostAsync(
            $"/api/recipes/{recipeId}/translate?lang=en", content: null);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = (await response.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeTranslationResponseDto>())!;
        Assert.True(body.IsStale);
        Assert.True(body.CacheHit);
        Assert.Single(_factory.AzureOpenAi.CompleteCalls);
    }

    [Fact]
    public async Task Translate_Stale_With_Force_Refreshes_Via_Llm()
    {
        var (userId, token) = await SignupAndLoginAsync("force@ex.com", "F");
        Authorise(token);
        var groupId = await CreateGroupAsync();
        var recipeId = await SeedRecipeWithSourceLanguageAsync(groupId, userId, "de");
        _factory.AzureOpenAi.SetTitle(ValidTranslationJson);
        await _client.PostAsync($"/api/recipes/{recipeId}/translate?lang=en", null);

        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var t = await db.RecipeTranslations
                .SingleAsync(x => x.RecipeId == recipeId && x.Language == "en");
            t.MarkStale();
            await db.SaveChangesAsync();
        }
        var freshJson = "{\"title\":\"Refreshed Spaetzle\",\"description\":null,"
            + "\"components\":[],\"tags\":[]}";
        _factory.AzureOpenAi.SetTitle(freshJson);

        var response = await _client.PostAsync(
            $"/api/recipes/{recipeId}/translate?lang=en&force=true", content: null);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = (await response.Content.ReadFromJsonAsync<RecipeEndpoints.RecipeTranslationResponseDto>())!;
        Assert.False(body.IsStale);
        Assert.False(body.CacheHit);
        Assert.Equal(freshJson, body.TranslatedPayload);
        Assert.Equal(2, _factory.AzureOpenAi.CompleteCalls.Count);
    }

    [Fact]
    public async Task Translate_503_When_Llm_Throws()
    {
        var (userId, token) = await SignupAndLoginAsync("throw@ex.com", "T");
        Authorise(token);
        var groupId = await CreateGroupAsync();
        var recipeId = await SeedRecipeWithSourceLanguageAsync(groupId, userId, "de");
        _factory.AzureOpenAi.MakeTitleFail();

        var response = await _client.PostAsync(
            $"/api/recipes/{recipeId}/translate?lang=en", content: null);

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.Equal("ai_service_unavailable",
            body.RootElement.GetProperty("code").GetString());
    }

    [Fact]
    public async Task Translate_503_When_Llm_Returns_Malformed_Json()
    {
        var (userId, token) = await SignupAndLoginAsync("malformed@ex.com", "MAL");
        Authorise(token);
        var groupId = await CreateGroupAsync();
        var recipeId = await SeedRecipeWithSourceLanguageAsync(groupId, userId, "de");
        _factory.AzureOpenAi.SetTitle("not a json document at all");

        var response = await _client.PostAsync(
            $"/api/recipes/{recipeId}/translate?lang=en", content: null);

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
    }

    // ── Stale-cascade integration ─────────────────────────────────

    [Fact]
    public async Task UpdateRecipe_Cascades_Stale_To_Existing_Translation()
    {
        var (userId, token) = await SignupAndLoginAsync("cascade@ex.com", "CAS");
        Authorise(token);
        var groupId = await CreateGroupAsync();
        var recipeId = await SeedRecipeWithSourceLanguageAsync(groupId, userId, "de");
        _factory.AzureOpenAi.SetTitle(ValidTranslationJson);

        await _client.PostAsync($"/api/recipes/{recipeId}/translate?lang=en", null);

        using (var seedScope = _factory.Services.CreateScope())
        {
            var seedDb = seedScope.ServiceProvider.GetRequiredService<AppDbContext>();
            var t = await seedDb.RecipeTranslations.AsNoTracking()
                .SingleAsync(x => x.RecipeId == recipeId && x.Language == "en");
            Assert.False(t.IsStale);
        }

        var update = new RecipeEndpoints.UpdateRecipeRequest(
            Title: "Spätzle Neu",
            Description: "Schwäbisch, frisch.",
            DefaultServings: 4,
            PrepTimeMinutes: 30,
            Difficulty: 1,
            SourceUrl: null,
            Components: new[]
            {
                new RecipeEndpoints.RecipeComponentRequest(0, null,
                    new[] { new RecipeEndpoints.IngredientRequest(0, 500m, "g", "Mehl", null, true) },
                    new[] { new RecipeEndpoints.StepRequest(0, "Mehl sieben.") }),
            },
            TagIds: Array.Empty<Guid>());
        var put = await _client.PutAsJsonAsync($"/api/recipes/{recipeId}", update);
        Assert.Equal(HttpStatusCode.OK, put.StatusCode);

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var stored = await db.RecipeTranslations.AsNoTracking()
            .SingleAsync(x => x.RecipeId == recipeId && x.Language == "en");
        Assert.True(stored.IsStale);
    }
}
