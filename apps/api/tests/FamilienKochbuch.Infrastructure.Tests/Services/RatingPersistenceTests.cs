using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.Enums;
using FamilienKochbuch.Infrastructure.Persistence;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace FamilienKochbuch.Infrastructure.Tests.Services;

/// <summary>
/// Persistence-level tests for the S4 <see cref="Rating"/> entity:
/// uniqueness on (RecipeId, UserId), cascade-from-Recipe, cascade-from-User,
/// and round-tripping the comment/Stars columns.
/// </summary>
public class RatingPersistenceTests : IAsyncLifetime
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
        user.SetEmail("rater@example.com");
        var other = new User { Role = UserRole.User };
        other.SetDisplayName("Zweiter");
        other.SetEmail("second@example.com");
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
    public async Task Rating_Round_Trips_With_Stars_And_Comment()
    {
        var recipe = AddRecipe();
        await _db.SaveChangesAsync();

        _db.Ratings.Add(new Rating(recipe.Id, _userId, 4, "Lecker!", DateTimeOffset.UtcNow));
        await _db.SaveChangesAsync();

        var fresh = await _db.Ratings.AsNoTracking().SingleAsync();
        Assert.Equal(4, fresh.Stars);
        Assert.Equal("Lecker!", fresh.Comment);
        Assert.Equal(_userId, fresh.UserId);
        Assert.Equal(recipe.Id, fresh.RecipeId);
    }

    [Fact]
    public async Task Unique_Rating_Per_User_Per_Recipe_Enforced()
    {
        var recipe = AddRecipe();
        await _db.SaveChangesAsync();

        _db.Ratings.Add(new Rating(recipe.Id, _userId, 5, null, DateTimeOffset.UtcNow));
        await _db.SaveChangesAsync();

        _db.Ratings.Add(new Rating(recipe.Id, _userId, 3, null, DateTimeOffset.UtcNow));
        await Assert.ThrowsAnyAsync<DbUpdateException>(() => _db.SaveChangesAsync());
    }

    [Fact]
    public async Task Different_Users_May_Rate_Same_Recipe()
    {
        var recipe = AddRecipe();
        await _db.SaveChangesAsync();

        _db.Ratings.Add(new Rating(recipe.Id, _userId, 5, null, DateTimeOffset.UtcNow));
        _db.Ratings.Add(new Rating(recipe.Id, _otherUserId, 3, null, DateTimeOffset.UtcNow));
        await _db.SaveChangesAsync();

        var count = await _db.Ratings.CountAsync(r => r.RecipeId == recipe.Id);
        Assert.Equal(2, count);
    }

    [Fact]
    public async Task Deleting_Recipe_Cascades_To_Ratings()
    {
        var recipe = AddRecipe();
        await _db.SaveChangesAsync();

        _db.Ratings.Add(new Rating(recipe.Id, _userId, 4, null, DateTimeOffset.UtcNow));
        _db.Ratings.Add(new Rating(recipe.Id, _otherUserId, 2, null, DateTimeOffset.UtcNow));
        await _db.SaveChangesAsync();

        _db.Recipes.Remove(recipe);
        await _db.SaveChangesAsync();

        Assert.Empty(await _db.Ratings.Where(r => r.RecipeId == recipe.Id).ToListAsync());
    }

    [Fact]
    public async Task Deleting_User_Cascades_To_Their_Ratings()
    {
        var recipe = AddRecipe();
        await _db.SaveChangesAsync();

        _db.Ratings.Add(new Rating(recipe.Id, _userId, 4, "von Haupt-User", DateTimeOffset.UtcNow));
        _db.Ratings.Add(new Rating(recipe.Id, _otherUserId, 3, "vom Zweiten", DateTimeOffset.UtcNow));
        await _db.SaveChangesAsync();

        var other = await _db.Users.SingleAsync(u => u.Id == _otherUserId);
        _db.Users.Remove(other);
        await _db.SaveChangesAsync();

        var remaining = await _db.Ratings.Where(r => r.RecipeId == recipe.Id).ToListAsync();
        Assert.Single(remaining);
        Assert.Equal(_userId, remaining[0].UserId);
    }
}
