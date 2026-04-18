using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.Enums;
using FamilienKochbuch.Infrastructure.Persistence;
using FamilienKochbuch.Infrastructure.Services;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace FamilienKochbuch.Infrastructure.Tests.Services;

/// <summary>
/// Tests for <see cref="PhotoPathMigrationService"/>, the idempotent
/// startup fixup that rewrites legacy Recipe.Photos entries from
/// "http://…/photos/recipe-photos/{guid}.ext" URLs to bare paths like
/// "recipes/{guid}.ext". Mirrors the pattern used by
/// <see cref="SeedDataService.BackfillPrivateCollectionsAsync"/>.
/// </summary>
public class PhotoPathMigrationServiceTests : IAsyncLifetime
{
    private SqliteConnection _connection = null!;
    private DbContextOptions<AppDbContext> _options = null!;

    public Task InitializeAsync()
    {
        _connection = new SqliteConnection("DataSource=:memory:");
        _connection.Open();
        _options = new DbContextOptionsBuilder<AppDbContext>()
            .UseSqlite(_connection)
            .Options;
        using var db = new AppDbContext(_options);
        db.Database.EnsureCreated();
        return Task.CompletedTask;
    }

    public async Task DisposeAsync()
    {
        await _connection.DisposeAsync();
    }

    private AppDbContext NewContext() => new(_options);

    private async Task<(Guid UserId, Guid GroupId)> SeedFixtureAsync()
    {
        await using var db = NewContext();
        var user = new User
        {
            Id = Guid.NewGuid(),
            UserName = "u@example.com",
            NormalizedUserName = "U@EXAMPLE.COM",
            Role = UserRole.User,
        };
        user.SetEmail("u@example.com");
        user.SetDisplayName("U");
        db.Users.Add(user);

        var group = new Group("Fam", null, DateTimeOffset.UtcNow, defaultServings: 2m);
        db.Groups.Add(group);
        await db.SaveChangesAsync();
        return (user.Id, group.Id);
    }

    private Recipe NewRecipe(Guid groupId, Guid userId, params string[] photos)
    {
        var recipe = new Recipe(
            groupId: groupId,
            createdByUserId: userId,
            title: "Test",
            description: null,
            defaultServings: 2,
            prepTimeMinutes: null,
            difficulty: 1,
            sourceUrl: null,
            sourceType: RecipeSourceType.Manual,
            forkOfRecipeId: null,
            createdAt: DateTimeOffset.UtcNow);
        foreach (var p in photos) recipe.AddPhoto(p);
        return recipe;
    }

    // ── Rewrites the legacy S3-era public URLs ──────────────────────

    [Fact]
    public async Task NormalizePhotoPathsAsync_Rewrites_Localhost_S3_Urls_To_Bare_Path()
    {
        var (userId, groupId) = await SeedFixtureAsync();
        Guid recipeId;
        await using (var db = NewContext())
        {
            var recipe = NewRecipe(groupId, userId,
                "http://localhost/photos/recipe-photos/ab12ab12ab12ab12ab12ab12ab12ab12.png");
            db.Recipes.Add(recipe);
            await db.SaveChangesAsync();
            recipeId = recipe.Id;
        }

        await using (var db = NewContext())
        {
            var svc = new PhotoPathMigrationService(db, NullLogger<PhotoPathMigrationService>.Instance);
            await svc.NormalizePhotoPathsAsync();
        }

        await using (var db = NewContext())
        {
            var recipe = await db.Recipes.SingleAsync(r => r.Id == recipeId);
            var photo = Assert.Single(recipe.Photos);
            Assert.Equal("recipes/ab12ab12ab12ab12ab12ab12ab12ab12.png", photo);
        }
    }

    [Fact]
    public async Task NormalizePhotoPathsAsync_Rewrites_Direct_SeaweedFs_Urls()
    {
        var (userId, groupId) = await SeedFixtureAsync();
        Guid recipeId;
        await using (var db = NewContext())
        {
            var recipe = NewRecipe(groupId, userId,
                "http://seaweedfs:8333/recipe-photos/cafebabecafebabecafebabecafebabe.jpg");
            db.Recipes.Add(recipe);
            await db.SaveChangesAsync();
            recipeId = recipe.Id;
        }

        await using (var db = NewContext())
        {
            var svc = new PhotoPathMigrationService(db, NullLogger<PhotoPathMigrationService>.Instance);
            await svc.NormalizePhotoPathsAsync();
        }

        await using (var db = NewContext())
        {
            var recipe = await db.Recipes.SingleAsync(r => r.Id == recipeId);
            var photo = Assert.Single(recipe.Photos);
            Assert.Equal("recipes/cafebabecafebabecafebabecafebabe.jpg", photo);
        }
    }

    // ── Leaves already-bare paths untouched ─────────────────────────

    [Fact]
    public async Task NormalizePhotoPathsAsync_Leaves_Bare_Path_Untouched()
    {
        var (userId, groupId) = await SeedFixtureAsync();
        Guid recipeId;
        await using (var db = NewContext())
        {
            var recipe = NewRecipe(groupId, userId, "recipes/deadbeefdeadbeefdeadbeefdeadbeef.png");
            db.Recipes.Add(recipe);
            await db.SaveChangesAsync();
            recipeId = recipe.Id;
        }

        await using (var db = NewContext())
        {
            var svc = new PhotoPathMigrationService(db, NullLogger<PhotoPathMigrationService>.Instance);
            await svc.NormalizePhotoPathsAsync();
        }

        await using (var db = NewContext())
        {
            var recipe = await db.Recipes.SingleAsync(r => r.Id == recipeId);
            var photo = Assert.Single(recipe.Photos);
            Assert.Equal("recipes/deadbeefdeadbeefdeadbeefdeadbeef.png", photo);
        }
    }

    // ── Handles a mix of legacy + new across multiple recipes ───────

    [Fact]
    public async Task NormalizePhotoPathsAsync_Handles_Mixed_Across_Recipes()
    {
        var (userId, groupId) = await SeedFixtureAsync();
        Guid legacyId, newId, mixedId;
        await using (var db = NewContext())
        {
            var legacy = NewRecipe(groupId, userId,
                "http://localhost/photos/recipe-photos/aaaa0000aaaa0000aaaa0000aaaa0000.png");
            var fresh = NewRecipe(groupId, userId, "recipes/bbbb1111bbbb1111bbbb1111bbbb1111.jpg");
            var mixed = NewRecipe(groupId, userId,
                "recipes/cccc2222cccc2222cccc2222cccc2222.webp",
                "http://localhost/photos/recipe-photos/dddd3333dddd3333dddd3333dddd3333.webp");
            db.Recipes.AddRange(legacy, fresh, mixed);
            await db.SaveChangesAsync();
            legacyId = legacy.Id; newId = fresh.Id; mixedId = mixed.Id;
        }

        await using (var db = NewContext())
        {
            var svc = new PhotoPathMigrationService(db, NullLogger<PhotoPathMigrationService>.Instance);
            await svc.NormalizePhotoPathsAsync();
        }

        await using (var db = NewContext())
        {
            var legacy = await db.Recipes.SingleAsync(r => r.Id == legacyId);
            Assert.Equal("recipes/aaaa0000aaaa0000aaaa0000aaaa0000.png", legacy.Photos[0]);

            var fresh = await db.Recipes.SingleAsync(r => r.Id == newId);
            Assert.Equal("recipes/bbbb1111bbbb1111bbbb1111bbbb1111.jpg", fresh.Photos[0]);

            var mixed = await db.Recipes.SingleAsync(r => r.Id == mixedId);
            Assert.Equal("recipes/cccc2222cccc2222cccc2222cccc2222.webp", mixed.Photos[0]);
            Assert.Equal("recipes/dddd3333dddd3333dddd3333dddd3333.webp", mixed.Photos[1]);
        }
    }

    // ── Idempotent: running twice yields identical state ────────────

    [Fact]
    public async Task NormalizePhotoPathsAsync_Is_Idempotent()
    {
        var (userId, groupId) = await SeedFixtureAsync();
        Guid recipeId;
        await using (var db = NewContext())
        {
            var recipe = NewRecipe(groupId, userId,
                "http://localhost/photos/recipe-photos/eeee4444eeee4444eeee4444eeee4444.png");
            db.Recipes.Add(recipe);
            await db.SaveChangesAsync();
            recipeId = recipe.Id;
        }

        await using (var db = NewContext())
        {
            var svc = new PhotoPathMigrationService(db, NullLogger<PhotoPathMigrationService>.Instance);
            await svc.NormalizePhotoPathsAsync();
            await svc.NormalizePhotoPathsAsync();
        }

        await using (var db = NewContext())
        {
            var recipe = await db.Recipes.SingleAsync(r => r.Id == recipeId);
            var photo = Assert.Single(recipe.Photos);
            Assert.Equal("recipes/eeee4444eeee4444eeee4444eeee4444.png", photo);
        }
    }

    // ── Handles a path without a recognizable filename segment ──────

    [Fact]
    public async Task NormalizePhotoPathsAsync_Skips_Unparseable_Entries_Without_Throwing()
    {
        var (userId, groupId) = await SeedFixtureAsync();
        Guid recipeId;
        await using (var db = NewContext())
        {
            var recipe = NewRecipe(groupId, userId, "something-completely-unrelated.txt");
            db.Recipes.Add(recipe);
            await db.SaveChangesAsync();
            recipeId = recipe.Id;
        }

        await using (var db = NewContext())
        {
            var svc = new PhotoPathMigrationService(db, NullLogger<PhotoPathMigrationService>.Instance);
            await svc.NormalizePhotoPathsAsync();
        }

        await using (var db = NewContext())
        {
            var recipe = await db.Recipes.SingleAsync(r => r.Id == recipeId);
            // Unparseable entries are left alone — the migration is defensive.
            Assert.Single(recipe.Photos);
        }
    }
}
