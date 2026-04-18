using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.Enums;
using FamilienKochbuch.Infrastructure.Persistence;
using FamilienKochbuch.Infrastructure.Services;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace FamilienKochbuch.Infrastructure.Tests.Services;

/// <summary>
/// Covers the SQLite-fallback branch of <see cref="PostgresRecipeSearchService"/>:
/// title/description/ingredient-name LIKE matching, AND semantics for
/// multi-tag filters, MinRating aggregate filtering, MaxPrepTime / creator
/// filters, and the random picker respecting the same filter set. Postgres-
/// specific full-text behaviour is exercised in docker-based acceptance
/// checks rather than unit tests.
/// </summary>
public class RecipeSearchServiceTests : IAsyncLifetime
{
    private SqliteConnection _connection = null!;
    private AppDbContext _db = null!;
    private IRecipeSearchService _service = null!;
    private Guid _groupId;
    private Guid _otherGroupId;
    private Guid _userId;
    private Guid _otherUserId;
    private Tag _tagSchnell = null!;
    private Tag _tagVegetarisch = null!;
    private Tag _tagWarm = null!;

    public async Task InitializeAsync()
    {
        _connection = new SqliteConnection("DataSource=:memory:");
        await _connection.OpenAsync();

        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseSqlite(_connection)
            .Options;
        _db = new AppDbContext(options);
        await _db.Database.EnsureCreatedAsync();

        var user = new User { Role = UserRole.User };
        user.SetDisplayName("Ersteller");
        user.SetEmail("creator@ex.com");
        var other = new User { Role = UserRole.User };
        other.SetDisplayName("Zweiter");
        other.SetEmail("other@ex.com");
        _db.Users.Add(user);
        _db.Users.Add(other);

        var group = new Group("Familie", null, DateTimeOffset.UtcNow);
        var otherGroup = new Group("WG", null, DateTimeOffset.UtcNow);
        _db.Groups.Add(group);
        _db.Groups.Add(otherGroup);

        // Seed a few tags.
        _tagSchnell = Tag.CreateGlobal("schnell", TagCategory.Aufwand);
        _tagVegetarisch = Tag.CreateGlobal("vegetarisch", TagCategory.Diaet);
        _tagWarm = Tag.CreateGlobal("warm", TagCategory.Typ);
        _db.Tags.AddRange(_tagSchnell, _tagVegetarisch, _tagWarm);

        await _db.SaveChangesAsync();

        _userId = user.Id;
        _otherUserId = other.Id;
        _groupId = group.Id;
        _otherGroupId = otherGroup.Id;

        _service = new PostgresRecipeSearchService(_db);
    }

    public async Task DisposeAsync()
    {
        await _db.DisposeAsync();
        await _connection.DisposeAsync();
    }

    private Recipe AddRecipe(
        string title,
        string? description = null,
        int? prepTimeMinutes = 30,
        Guid? createdByUserId = null,
        Guid? groupIdOverride = null,
        int offsetMinutes = 0,
        params string[] ingredientNames)
    {
        var recipe = new Recipe(
            groupId: groupIdOverride ?? _groupId,
            createdByUserId: createdByUserId ?? _userId,
            title: title,
            description: description,
            defaultServings: 4,
            prepTimeMinutes: prepTimeMinutes,
            difficulty: 1,
            sourceUrl: null,
            sourceType: RecipeSourceType.Manual,
            forkOfRecipeId: null,
            createdAt: DateTimeOffset.UtcNow.AddMinutes(offsetMinutes));
        int pos = 0;
        foreach (var name in ingredientNames)
        {
            recipe.Ingredients.Add(new Ingredient(recipe.Id, pos++, 100m, "g", name, null, true));
        }
        _db.Recipes.Add(recipe);
        return recipe;
    }

    private async Task Rate(Recipe recipe, Guid userId, int stars)
    {
        _db.Ratings.Add(new Rating(recipe.Id, userId, stars, null, DateTimeOffset.UtcNow));
        await _db.SaveChangesAsync();
    }

    private async Task Tag(Recipe recipe, params Tag[] tags)
    {
        foreach (var t in tags)
        {
            _db.RecipeTags.Add(new RecipeTag(recipe.Id, t.Id));
        }
        await _db.SaveChangesAsync();
    }

    // ── Title / description / ingredient LIKE search ────────────────────

    [Fact]
    public async Task SearchAsync_Matches_Title_Ingredient_Description()
    {
        var pasta = AddRecipe("Nudeln mit Pesto", description: "Schnelles Abendessen",
            ingredientNames: new[] { "Nudeln", "Basilikum" });
        var pizza = AddRecipe("Pizza Margherita", ingredientNames: new[] { "Mehl", "Tomaten" });
        AddRecipe("Salat", ingredientNames: new[] { "Rucola" });
        await _db.SaveChangesAsync();

        var hits = await _service.SearchAsync(_groupId,
            new RecipeSearchQuery { Q = "Nudeln" }, _userId, default);

        Assert.Equal(1, hits.Total);
        Assert.Equal(pasta.Id, hits.Items[0].Id);

        var descriptionHits = await _service.SearchAsync(_groupId,
            new RecipeSearchQuery { Q = "Abendessen" }, _userId, default);
        Assert.Equal(pasta.Id, Assert.Single(descriptionHits.Items).Id);

        var titleHits = await _service.SearchAsync(_groupId,
            new RecipeSearchQuery { Q = "Pizza" }, _userId, default);
        Assert.Equal(pizza.Id, Assert.Single(titleHits.Items).Id);
    }

    [Fact]
    public async Task SearchAsync_Only_Returns_Recipes_From_Requested_Group()
    {
        AddRecipe("Nudeln A");
        AddRecipe("Nudeln B", groupIdOverride: _otherGroupId);
        await _db.SaveChangesAsync();

        var hits = await _service.SearchAsync(_groupId,
            new RecipeSearchQuery { Q = "Nudeln" }, _userId, default);

        Assert.Equal(1, hits.Total);
        Assert.Equal("Nudeln A", hits.Items[0].Title);
    }

    [Fact]
    public async Task SearchAsync_Excludes_Soft_Deleted_Recipes()
    {
        var alive = AddRecipe("Aktiv");
        var gone = AddRecipe("Gelöscht");
        await _db.SaveChangesAsync();
        gone.SoftDelete(DateTimeOffset.UtcNow);
        await _db.SaveChangesAsync();

        var hits = await _service.SearchAsync(_groupId,
            new RecipeSearchQuery(), _userId, default);

        Assert.Equal(1, hits.Total);
        Assert.Equal(alive.Id, hits.Items[0].Id);
    }

    // ── Tag AND semantics ───────────────────────────────────────────────

    [Fact]
    public async Task SearchAsync_Tag_Filter_Requires_All_Tags()
    {
        var both = AddRecipe("Beide");
        var onlyOne = AddRecipe("Nur schnell");
        var none = AddRecipe("Keine");
        await _db.SaveChangesAsync();

        await Tag(both, _tagSchnell, _tagVegetarisch);
        await Tag(onlyOne, _tagSchnell);

        var hits = await _service.SearchAsync(_groupId, new RecipeSearchQuery
        {
            TagIds = new[] { _tagSchnell.Id, _tagVegetarisch.Id },
        }, _userId, default);

        Assert.Equal(1, hits.Total);
        Assert.Equal(both.Id, hits.Items[0].Id);
        _ = onlyOne;
        _ = none;
    }

    // ── MinRating (uses avg) ────────────────────────────────────────────

    [Fact]
    public async Task SearchAsync_MinRating_Uses_Average_Of_Stars()
    {
        var good = AddRecipe("Gut");
        var mediocre = AddRecipe("Mittel");
        var unrated = AddRecipe("Ohne Bewertung");
        await _db.SaveChangesAsync();

        await Rate(good, _userId, 5);
        await Rate(good, _otherUserId, 4); // avg 4.5
        await Rate(mediocre, _userId, 3);
        await Rate(mediocre, _otherUserId, 2); // avg 2.5

        var hits = await _service.SearchAsync(_groupId,
            new RecipeSearchQuery { MinRating = 4.0 }, _userId, default);

        Assert.Equal(1, hits.Total);
        Assert.Equal(good.Id, hits.Items[0].Id);
        _ = unrated;
    }

    [Fact]
    public async Task SearchAsync_Includes_Aggregate_AvgRating_And_Count_In_Summary()
    {
        var rated = AddRecipe("Bewertet");
        await _db.SaveChangesAsync();
        await Rate(rated, _userId, 5);
        await Rate(rated, _otherUserId, 3);

        var hits = await _service.SearchAsync(_groupId,
            new RecipeSearchQuery(), _userId, default);

        var summary = Assert.Single(hits.Items);
        Assert.Equal(rated.Id, summary.Id);
        Assert.NotNull(summary.AvgRating);
        Assert.Equal(4.0, summary.AvgRating!.Value, precision: 2);
        Assert.Equal(2, summary.RatingCount);
        Assert.Equal(5, summary.MyStars);
    }

    [Fact]
    public async Task SearchAsync_MyStars_Is_Null_When_Current_User_Did_Not_Rate()
    {
        var rated = AddRecipe("Bewertet");
        await _db.SaveChangesAsync();
        await Rate(rated, _otherUserId, 4);

        var hits = await _service.SearchAsync(_groupId,
            new RecipeSearchQuery(), _userId, default);

        var summary = Assert.Single(hits.Items);
        Assert.Equal(4.0, summary.AvgRating!.Value, precision: 2);
        Assert.Equal(1, summary.RatingCount);
        Assert.Null(summary.MyStars);
    }

    // ── MaxPrepTime + CreatedBy ─────────────────────────────────────────

    [Fact]
    public async Task SearchAsync_MaxPrepTime_Filters_Long_Recipes_Out()
    {
        AddRecipe("Schnell", prepTimeMinutes: 15);
        AddRecipe("Lang", prepTimeMinutes: 90);
        await _db.SaveChangesAsync();

        var hits = await _service.SearchAsync(_groupId,
            new RecipeSearchQuery { MaxPrepTimeMinutes = 30 }, _userId, default);

        Assert.Equal(1, hits.Total);
        Assert.Equal("Schnell", hits.Items[0].Title);
    }

    [Fact]
    public async Task SearchAsync_CreatedByUserId_Filters_By_Author()
    {
        AddRecipe("Meins", createdByUserId: _userId);
        AddRecipe("Fremd", createdByUserId: _otherUserId);
        await _db.SaveChangesAsync();

        var hits = await _service.SearchAsync(_groupId,
            new RecipeSearchQuery { CreatedByUserId = _otherUserId }, _userId, default);

        Assert.Equal(1, hits.Total);
        Assert.Equal("Fremd", hits.Items[0].Title);
    }

    // ── AND combination ─────────────────────────────────────────────────

    [Fact]
    public async Task SearchAsync_Combines_Q_Tag_MinRating_AND_Style()
    {
        var winner = AddRecipe("Schnelle Nudeln",
            ingredientNames: new[] { "Nudeln" }, prepTimeMinutes: 15);
        var noTag = AddRecipe("Schnelle Nudeln ohne Tag",
            ingredientNames: new[] { "Nudeln" }, prepTimeMinutes: 15);
        var lowRated = AddRecipe("Schlechte Nudeln",
            ingredientNames: new[] { "Nudeln" });
        var off = AddRecipe("Reis");
        await _db.SaveChangesAsync();

        await Tag(winner, _tagSchnell);
        await Tag(lowRated, _tagSchnell);
        await Rate(winner, _userId, 5);
        await Rate(lowRated, _userId, 1);

        var hits = await _service.SearchAsync(_groupId, new RecipeSearchQuery
        {
            Q = "Nudeln",
            TagIds = new[] { _tagSchnell.Id },
            MinRating = 4.0,
        }, _userId, default);

        Assert.Equal(1, hits.Total);
        Assert.Equal(winner.Id, hits.Items[0].Id);
        _ = noTag;
        _ = off;
    }

    // ── Sorting ─────────────────────────────────────────────────────────

    [Fact]
    public async Task SearchAsync_Sort_Newest_Orders_By_CreatedAt_Desc()
    {
        var old = AddRecipe("Alt", offsetMinutes: -60);
        var @new = AddRecipe("Neu", offsetMinutes: 0);
        await _db.SaveChangesAsync();

        var hits = await _service.SearchAsync(_groupId,
            new RecipeSearchQuery { Sort = SearchSort.Newest }, _userId, default);

        Assert.Equal(2, hits.Total);
        Assert.Equal(@new.Id, hits.Items[0].Id);
        Assert.Equal(old.Id, hits.Items[1].Id);
    }

    [Fact]
    public async Task SearchAsync_Sort_BestRated_Orders_By_Avg_Desc()
    {
        var lo = AddRecipe("Schlecht");
        var hi = AddRecipe("Super");
        var unrated = AddRecipe("Ohne");
        await _db.SaveChangesAsync();

        await Rate(lo, _userId, 1);
        await Rate(hi, _userId, 5);

        var hits = await _service.SearchAsync(_groupId,
            new RecipeSearchQuery { Sort = SearchSort.BestRated }, _userId, default);

        Assert.Equal(3, hits.Total);
        Assert.Equal(hi.Id, hits.Items[0].Id);
        // Unrated last (avg = null), behind the 1-star lo. Exact ordering of
        // unrated-vs-rated is implementation-defined, but best-rated must be
        // first.
        _ = unrated;
    }

    // ── Pagination ──────────────────────────────────────────────────────

    [Fact]
    public async Task SearchAsync_Paginates_And_Reports_Total()
    {
        for (int i = 0; i < 12; i++)
        {
            AddRecipe($"Rezept {i:00}", offsetMinutes: -i);
        }
        await _db.SaveChangesAsync();

        var pageOne = await _service.SearchAsync(_groupId,
            new RecipeSearchQuery { Page = 1, PageSize = 5, Sort = SearchSort.Newest },
            _userId, default);
        Assert.Equal(12, pageOne.Total);
        Assert.Equal(5, pageOne.Items.Count);

        var pageThree = await _service.SearchAsync(_groupId,
            new RecipeSearchQuery { Page = 3, PageSize = 5, Sort = SearchSort.Newest },
            _userId, default);
        Assert.Equal(12, pageThree.Total);
        Assert.Equal(2, pageThree.Items.Count); // 12 - 2*5 = 2 on page 3
    }

    // ── RandomAsync ─────────────────────────────────────────────────────

    [Fact]
    public async Task RandomAsync_Returns_Null_When_No_Match()
    {
        var id = await _service.RandomAsync(_groupId,
            new RecipeSearchQuery { Q = "etwas-das-nicht-existiert" }, _userId, default);

        Assert.Null(id);
    }

    [Fact]
    public async Task RandomAsync_Respects_Filters()
    {
        var winner = AddRecipe("Nudeln Spezial");
        var other = AddRecipe("Pizza Classico");
        await _db.SaveChangesAsync();

        await Tag(winner, _tagSchnell);
        await Tag(other, _tagVegetarisch);

        // Filter on Q="Nudeln" + tag=schnell — only `winner` qualifies. Run
        // multiple times to make sure it never returns `other`.
        for (int i = 0; i < 10; i++)
        {
            var id = await _service.RandomAsync(_groupId, new RecipeSearchQuery
            {
                Q = "Nudeln",
                TagIds = new[] { _tagSchnell.Id },
            }, _userId, default);
            Assert.Equal(winner.Id, id);
        }
    }

    // ── SQLite fallback sanity ──────────────────────────────────────────

    [Fact]
    public void Service_Reports_Sqlite_As_Active_Provider_For_Fallback()
    {
        // The guard inside PostgresRecipeSearchService uses
        // context.Database.ProviderName — confirm that the fixture-backed
        // context reports the expected value so the fallback branch is the
        // one actually executing.
        Assert.Contains("Sqlite", _db.Database.ProviderName ?? string.Empty);
    }
}
