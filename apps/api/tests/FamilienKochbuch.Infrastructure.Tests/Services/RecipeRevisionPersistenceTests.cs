using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.Enums;
using FamilienKochbuch.Infrastructure.Persistence;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace FamilienKochbuch.Infrastructure.Tests.Services;

/// <summary>
/// Persistence-level tests for the S6 <see cref="RecipeRevision"/> entity:
/// columns round-trip, Recipe-cascade drops revisions, User-restrict
/// blocks deletes that would orphan history, and the
/// (RecipeId, CreatedAt) composite index is registered for the "last 5"
/// lookup pattern.
/// </summary>
public class RecipeRevisionPersistenceTests : IAsyncLifetime
{
    private SqliteConnection _connection = null!;
    private AppDbContext _db = null!;
    private Guid _groupId;
    private Guid _userId;
    private Guid _otherUserId;

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
        user.SetEmail("rev@example.com");
        var other = new User { Role = UserRole.User };
        other.SetDisplayName("Zweiter");
        other.SetEmail("rev-other@example.com");
        var group = new Group("Familie", null, DateTimeOffset.UtcNow);
        _db.Users.Add(user);
        _db.Users.Add(other);
        _db.Groups.Add(group);
        await _db.SaveChangesAsync();

        _userId = user.Id;
        _otherUserId = other.Id;
        _groupId = group.Id;
    }

    public async Task DisposeAsync()
    {
        await _db.DisposeAsync();
        await _connection.DisposeAsync();
    }

    private Recipe AddRecipe()
    {
        var recipe = new Recipe(
            groupId: _groupId,
            createdByUserId: _userId,
            title: "Spätzle",
            description: null,
            defaultServings: 4,
            prepTimeMinutes: 30,
            difficulty: 1,
            sourceUrl: null,
            sourceType: RecipeSourceType.Manual,
            forkOfRecipeId: null,
            createdAt: DateTimeOffset.UtcNow);
        _db.Recipes.Add(recipe);
        return recipe;
    }

    [Fact]
    public async Task Revision_Round_Trips_All_Columns()
    {
        var recipe = AddRecipe();
        await _db.SaveChangesAsync();

        var now = DateTimeOffset.UtcNow;
        var revision = new RecipeRevision(
            recipeId: recipe.Id,
            changedByUserId: _userId,
            changeType: RecipeChangeType.Edited,
            snapshotJson: "{\"title\":\"Spätzle\"}",
            diffSummary: "Titel geändert",
            createdAt: now);
        _db.RecipeRevisions.Add(revision);
        await _db.SaveChangesAsync();

        var fresh = await _db.RecipeRevisions.AsNoTracking().SingleAsync();
        Assert.Equal(recipe.Id, fresh.RecipeId);
        Assert.Equal(_userId, fresh.ChangedByUserId);
        Assert.Equal(RecipeChangeType.Edited, fresh.ChangeType);
        Assert.Equal("{\"title\":\"Spätzle\"}", fresh.SnapshotJson);
        Assert.Equal("Titel geändert", fresh.DiffSummary);
        Assert.Equal(now, fresh.CreatedAt, precision: TimeSpan.FromMilliseconds(1));
    }

    [Fact]
    public async Task Deleting_Recipe_Cascades_To_Revisions()
    {
        var recipe = AddRecipe();
        await _db.SaveChangesAsync();

        _db.RecipeRevisions.Add(new RecipeRevision(
            recipe.Id, _userId, RecipeChangeType.Created,
            "{\"v\":1}", null, DateTimeOffset.UtcNow));
        _db.RecipeRevisions.Add(new RecipeRevision(
            recipe.Id, _userId, RecipeChangeType.Edited,
            "{\"v\":2}", "x", DateTimeOffset.UtcNow));
        await _db.SaveChangesAsync();

        _db.Recipes.Remove(recipe);
        await _db.SaveChangesAsync();

        Assert.Empty(await _db.RecipeRevisions.Where(r => r.RecipeId == recipe.Id).ToListAsync());
    }

    [Fact]
    public async Task Deleting_User_With_Revisions_Is_Restricted()
    {
        var recipe = AddRecipe();
        await _db.SaveChangesAsync();

        _db.RecipeRevisions.Add(new RecipeRevision(
            recipe.Id, _otherUserId, RecipeChangeType.Created,
            "{\"v\":1}", null, DateTimeOffset.UtcNow));
        await _db.SaveChangesAsync();

        var other = await _db.Users.SingleAsync(u => u.Id == _otherUserId);
        _db.Users.Remove(other);

        await Assert.ThrowsAnyAsync<DbUpdateException>(() => _db.SaveChangesAsync());
    }

    [Fact]
    public async Task Composite_Index_On_RecipeId_And_CreatedAt_Is_Defined()
    {
        var entity = _db.Model.FindEntityType(typeof(RecipeRevision));
        Assert.NotNull(entity);
        var indexes = entity!.GetIndexes()
            .Where(i => i.Properties.Count == 2
                && i.Properties[0].Name == "RecipeId"
                && i.Properties[1].Name == "CreatedAt")
            .ToList();
        Assert.Single(indexes);
    }
}
