using System.Text.Json;
using SharedCookbook.Domain.Entities;
using SharedCookbook.Domain.Enums;
using SharedCookbook.Infrastructure.Persistence;
using SharedCookbook.Infrastructure.Services;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace SharedCookbook.Infrastructure.Tests.Services;

/// <summary>
/// Unit tests for the S6 <see cref="RecipeRevisionService"/>: it snapshots
/// the current recipe state into JSON, computes a German diff summary
/// against the previous revision (if any), prunes to the last five rows
/// per recipe, and refuses to record no-op edits. Backed by SQLite
/// in-memory for fidelity; the snapshot shape is contract-tested directly.
/// </summary>
public class RecipeRevisionServiceTests : IAsyncLifetime
{
    private SqliteConnection _connection = null!;
    private AppDbContext _db = null!;
    private RecipeRevisionService _service = null!;
    private Guid _userId;
    private Guid _groupId;
    private DateTimeOffset _now = new(2026, 4, 18, 12, 0, 0, TimeSpan.Zero);

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
        user.SetDisplayName("Tester");
        user.SetEmail("svc@example.com");
        var group = new Group("Familie", null, _now);
        _db.Users.Add(user);
        _db.Groups.Add(group);
        await _db.SaveChangesAsync();

        _userId = user.Id;
        _groupId = group.Id;

        _service = new RecipeRevisionService(_db);
    }

    public async Task DisposeAsync()
    {
        await _db.DisposeAsync();
        await _connection.DisposeAsync();
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    private async Task<Recipe> CreateRecipeAsync(
        string title = "Spätzle",
        int defaultServings = 4,
        int difficulty = 1,
        Action<Recipe>? configure = null)
    {
        var recipe = new Recipe(
            groupId: _groupId,
            createdByUserId: _userId,
            title: title,
            description: "Beschreibung",
            defaultServings: defaultServings,
            prepTimeMinutes: 30,
            difficulty: difficulty,
            sourceUrl: null,
            sourceType: RecipeSourceType.Manual,
            forkOfRecipeId: null,
            createdAt: _now);

        // COMP-0 — seed a single default component + its ingredients + steps
        // via the aggregate's ReplaceComponents so the invariant checks run.
        var defaultComponent = new RecipeComponent(recipe.Id, 0, null);
        var seededIngredients = new[]
        {
            new Ingredient(recipe.Id, defaultComponent.Id, 0, 500m, "g", "Mehl", null, true),
            new Ingredient(recipe.Id, defaultComponent.Id, 1, 3m, "Stück", "Eier", null, true),
        };
        var seededSteps = new[]
        {
            new RecipeStep(recipe.Id, defaultComponent.Id, 0, "Mehl vermengen."),
            new RecipeStep(recipe.Id, defaultComponent.Id, 1, "Eier zugeben."),
        };
        recipe.ReplaceComponents(new[] { defaultComponent }, seededIngredients, seededSteps);

        configure?.Invoke(recipe);

        _db.Recipes.Add(recipe);
        await _db.SaveChangesAsync();
        return recipe;
    }

    private async Task<Recipe> ReloadAsync(Guid id) =>
        (await _db.Recipes
            .Include(r => r.Ingredients)
            .Include(r => r.Steps)
            .Include(r => r.RecipeTags)
            .AsNoTracking()
            .FirstOrDefaultAsync(r => r.Id == id))!;

    // ── RecordAsync inserts ────────────────────────────────────────────

    [Fact]
    public async Task RecordAsync_Inserts_Created_Revision_With_Snapshot()
    {
        var recipe = await CreateRecipeAsync("Pizza");

        await _service.RecordAsync(recipe.Id, _userId, RecipeChangeType.Created, _now, default);

        var rows = await _db.RecipeRevisions.AsNoTracking()
            .Where(r => r.RecipeId == recipe.Id)
            .ToListAsync();
        var revision = Assert.Single(rows);
        Assert.Equal(RecipeChangeType.Created, revision.ChangeType);
        Assert.Equal(_userId, revision.ChangedByUserId);
        Assert.False(string.IsNullOrWhiteSpace(revision.SnapshotJson));

        var snapshot = JsonSerializer.Deserialize<JsonElement>(revision.SnapshotJson);
        Assert.Equal("Pizza", snapshot.GetProperty("title").GetString());
        Assert.Equal(4, snapshot.GetProperty("defaultServings").GetInt32());
        Assert.Equal(2, snapshot.GetProperty("ingredients").GetArrayLength());
        Assert.Equal(2, snapshot.GetProperty("steps").GetArrayLength());
        Assert.Equal(0, snapshot.GetProperty("tagIds").GetArrayLength());
    }

    // ── Pruning ────────────────────────────────────────────────────────

    [Fact]
    public async Task RecordAsync_Prunes_To_Last_Five_After_Sixth_Insert()
    {
        var recipe = await CreateRecipeAsync("Auflauf");

        for (var i = 0; i < 6; i++)
        {
            if (i > 0)
            {
                // Mutate the recipe between revisions so the no-op guard
                // doesn't suppress the inserts. Bump the title so each
                // snapshot is unique.
                var tracked = await _db.Recipes.FirstAsync(r => r.Id == recipe.Id);
                tracked.UpdateMetadata(
                    title: $"Auflauf v{i}",
                    description: tracked.Description,
                    defaultServings: tracked.DefaultServings,
                    prepTimeMinutes: tracked.PrepTimeMinutes,
                    difficulty: tracked.Difficulty,
                    sourceUrl: tracked.SourceUrl,
                    sourceType: tracked.SourceType,
                    updatedAt: _now.AddMinutes(i));
                await _db.SaveChangesAsync();
            }

            await _service.RecordAsync(
                recipe.Id, _userId,
                i == 0 ? RecipeChangeType.Created : RecipeChangeType.Edited,
                _now.AddMinutes(i),
                default);
        }

        var rowsRaw = await _db.RecipeRevisions.AsNoTracking()
            .Where(r => r.RecipeId == recipe.Id)
            .ToListAsync();
        var rows = rowsRaw.OrderBy(r => r.CreatedAt).ToList();

        Assert.Equal(5, rows.Count);
        // Oldest (the Created one at minute 0) should be gone — we kept
        // the five most-recent.
        Assert.All(rows, r => Assert.NotEqual(_now, r.CreatedAt));
        Assert.Equal(_now.AddMinutes(1), rows.First().CreatedAt);
        Assert.Equal(_now.AddMinutes(5), rows.Last().CreatedAt);
    }

    // ── No-op detection ────────────────────────────────────────────────

    [Fact]
    public async Task RecordAsync_Skips_Insert_When_Snapshot_Identical_To_Previous()
    {
        var recipe = await CreateRecipeAsync("Stabil");

        // Initial Created revision.
        await _service.RecordAsync(recipe.Id, _userId, RecipeChangeType.Created, _now, default);
        // Second call without any underlying change → must not insert.
        await _service.RecordAsync(recipe.Id, _userId, RecipeChangeType.Edited, _now.AddMinutes(1), default);

        var count = await _db.RecipeRevisions.CountAsync(r => r.RecipeId == recipe.Id);
        Assert.Equal(1, count);
    }

    [Fact]
    public async Task RecordAsync_Always_Inserts_For_Created_Even_If_No_Prior()
    {
        var recipe = await CreateRecipeAsync("Anlegen");

        await _service.RecordAsync(recipe.Id, _userId, RecipeChangeType.Created, _now, default);

        Assert.Equal(1, await _db.RecipeRevisions.CountAsync(r => r.RecipeId == recipe.Id));
    }

    // ── DiffSummary content ────────────────────────────────────────────

    [Fact]
    public async Task RecordAsync_Edited_Summary_Mentions_Title_And_Counts()
    {
        var recipe = await CreateRecipeAsync("Erste");
        await _service.RecordAsync(recipe.Id, _userId, RecipeChangeType.Created, _now, default);

        // Mutate the recipe in a fresh DbContext to avoid change-tracker
        // collisions with the AsNoTracking includes the service issues.
        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseSqlite(_connection)
            .Options;
        await using (var mutationDb = new AppDbContext(options))
        {
            var tracked = await mutationDb.Recipes.FirstAsync(r => r.Id == recipe.Id);
            tracked.UpdateMetadata(
                title: "Zweite",
                description: tracked.Description,
                defaultServings: tracked.DefaultServings,
                prepTimeMinutes: tracked.PrepTimeMinutes,
                difficulty: tracked.Difficulty,
                sourceUrl: tracked.SourceUrl,
                sourceType: tracked.SourceType,
                updatedAt: _now.AddMinutes(1));
            await mutationDb.SaveChangesAsync();

            // COMP-0 — add the new ingredient under the existing default
            // component so the ComponentId FK stays valid.
            var existingComponentId = await mutationDb.RecipeComponents
                .Where(c => c.RecipeId == recipe.Id)
                .Select(c => c.Id)
                .FirstAsync();
            mutationDb.Ingredients.Add(
                new Ingredient(recipe.Id, existingComponentId, 2, 100m, "g", "Salz", null, true));
            await mutationDb.SaveChangesAsync();

            var firstStep = await mutationDb.RecipeSteps
                .Where(s => s.RecipeId == recipe.Id)
                .FirstAsync(s => s.Position == 0);
            mutationDb.RecipeSteps.Remove(firstStep);
            await mutationDb.SaveChangesAsync();
        }
        _db.ChangeTracker.Clear();

        await _service.RecordAsync(recipe.Id, _userId, RecipeChangeType.Edited, _now.AddMinutes(2), default);

        var allRevisions = await _db.RecipeRevisions.AsNoTracking()
            .Where(r => r.RecipeId == recipe.Id)
            .ToListAsync();
        var latest = allRevisions.OrderByDescending(r => r.CreatedAt).First();

        Assert.Equal(RecipeChangeType.Edited, latest.ChangeType);
        Assert.False(string.IsNullOrWhiteSpace(latest.DiffSummary));
        Assert.Contains("Titel", latest.DiffSummary!);
        Assert.Contains("Zutat", latest.DiffSummary);
        Assert.Contains("Schritt", latest.DiffSummary);
    }

    [Fact]
    public async Task RecordAsync_Forked_Summary_Mentions_Source_Group_When_Provided()
    {
        var recipe = await CreateRecipeAsync("Fork");

        await _service.RecordAsync(
            recipe.Id, _userId, RecipeChangeType.Forked, _now,
            sourceDescription: "Geforkt aus Gruppe Familie", ct: default);

        var revision = await _db.RecipeRevisions.AsNoTracking()
            .SingleAsync(r => r.RecipeId == recipe.Id);
        Assert.Equal(RecipeChangeType.Forked, revision.ChangeType);
        Assert.Equal("Geforkt aus Gruppe Familie", revision.DiffSummary);
    }

    // ── GetLastAsync ───────────────────────────────────────────────────

    [Fact]
    public async Task GetLastAsync_Returns_Newest_First_Limited_To_Take()
    {
        var recipe = await CreateRecipeAsync("Liste");

        // Insert raw revisions to control timestamps without touching the
        // pruning path.
        for (var i = 0; i < 4; i++)
        {
            _db.RecipeRevisions.Add(new RecipeRevision(
                recipe.Id, _userId,
                i == 0 ? RecipeChangeType.Created : RecipeChangeType.Edited,
                $"{{\"v\":{i}}}", null, _now.AddMinutes(i)));
        }
        await _db.SaveChangesAsync();

        var rows = await _service.GetLastAsync(recipe.Id, take: 3, default);

        Assert.Equal(3, rows.Count);
        Assert.Equal(_now.AddMinutes(3), rows[0].CreatedAt);
        Assert.Equal(_now.AddMinutes(2), rows[1].CreatedAt);
        Assert.Equal(_now.AddMinutes(1), rows[2].CreatedAt);
    }
}
