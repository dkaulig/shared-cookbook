using SharedCookbook.Infrastructure.Persistence;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace SharedCookbook.Infrastructure.Tests.Services;

/// <summary>
/// COMP-0 — contract test for the
/// <c>20260421191207_AddRecipeComponents</c> migration's backfill.
///
/// Stages:
/// <list type="number">
/// <item>Boot a fresh SQLite in-memory DB and migrate up to the
/// previous migration only (<c>AddRecipesListPaginationIndexes</c>),
/// so the schema has the pre-COMP-0 <c>Recipes</c> /
/// <c>Ingredients</c> / <c>RecipeSteps</c> tables but no
/// <c>RecipeComponents</c> and no <c>ComponentId</c> column.</item>
/// <item>Seed two recipes with mixed ingredients + steps via raw SQL
/// so every row has the pre-COMP-0 shape (no <c>ComponentId</c>).</item>
/// <item>Apply the <c>AddRecipeComponents</c> migration.</item>
/// <item>Assert every existing recipe got exactly one default
/// component (<c>Label = NULL</c>, <c>Position = 0</c>) and that
/// every ingredient + step row is wired to that component's id.</item>
/// </list>
/// </summary>
public class AddRecipeComponentsMigrationTests : IAsyncLifetime
{
    private const string PreviousMigration = "20260421134152_AddRecipesListPaginationIndexes";
    private const string TargetMigration = "20260421192424_AddRecipeComponents";

    private SqliteConnection _connection = null!;

    public async Task InitializeAsync()
    {
        _connection = new SqliteConnection("DataSource=:memory:");
        await _connection.OpenAsync();
    }

    public async Task DisposeAsync()
    {
        await _connection.DisposeAsync();
    }

    private AppDbContext CreateContext()
    {
        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseSqlite(_connection)
            .ConfigureWarnings(w => w.Ignore(RelationalEventId.PendingModelChangesWarning))
            .Options;
        return new AppDbContext(options);
    }

    [Fact]
    public async Task Migration_Backfills_Default_Component_For_Every_Existing_Recipe()
    {
        // Stage 1 — migrate to the pre-COMP-0 schema.
        using (var pre = CreateContext())
        {
            var migrator = pre.GetInfrastructure().GetRequiredService<IMigrator>();
            await migrator.MigrateAsync(PreviousMigration);
        }

        // Stage 2 — seed two recipes with the pre-COMP-0 shape via raw
        // SQL. We insert into AspNetUsers + Groups first so the recipe
        // FKs resolve, then Recipes + Ingredients + RecipeSteps.
        var recipeAId = Guid.NewGuid();
        var recipeBId = Guid.NewGuid();
        var userId = Guid.NewGuid();
        var groupId = Guid.NewGuid();
        await using (var cmd = _connection.CreateCommand())
        {
            cmd.CommandText = $"""
                INSERT INTO AspNetUsers (Id, UserName, NormalizedUserName, Email, NormalizedEmail, EmailConfirmed, PasswordHash, SecurityStamp, ConcurrencyStamp, PhoneNumber, PhoneNumberConfirmed, TwoFactorEnabled, LockoutEnd, LockoutEnabled, AccessFailedCount, DisplayName, Role, CreatedAt)
                VALUES ('{userId}', 'u', 'U', 'u@x', 'U@X', 1, NULL, NULL, NULL, NULL, 0, 0, NULL, 1, 0, 'Tester', 0, '2026-04-21 12:00:00+00:00');

                INSERT INTO Groups (Id, Name, DefaultServings, IsPrivateCollection, CreatedAt, DeletedAt, Version)
                VALUES ('{groupId}', 'Familie', 4, 0, '2026-04-21 12:00:00+00:00', NULL, 0);

                INSERT INTO Recipes (Id, GroupId, CreatedByUserId, Title, Description, DefaultServings, PrepTimeMinutes, Difficulty, SourceUrl, SourceType, ForkOfRecipeId, Photos, LastCookedAt, CreatedAt, UpdatedAt, DeletedAt, NutritionEstimate, Version)
                VALUES ('{recipeAId}', '{groupId}', '{userId}', 'A', NULL, 4, NULL, 1, NULL, 0, NULL, '[]', NULL, '2026-04-21 12:00:00+00:00', '2026-04-21 12:00:00+00:00', NULL, NULL, 0),
                       ('{recipeBId}', '{groupId}', '{userId}', 'B', NULL, 4, NULL, 1, NULL, 0, NULL, '[]', NULL, '2026-04-21 12:00:00+00:00', '2026-04-21 12:00:00+00:00', NULL, NULL, 0);

                INSERT INTO Ingredients (Id, RecipeId, Position, Quantity, Unit, Name, Note, Scalable)
                VALUES ('{Guid.NewGuid()}', '{recipeAId}', 0, 500, 'g', 'Mehl', NULL, 1),
                       ('{Guid.NewGuid()}', '{recipeAId}', 1, 3, 'Stueck', 'Eier', NULL, 1),
                       ('{Guid.NewGuid()}', '{recipeBId}', 0, 100, 'ml', 'Milch', NULL, 1);

                INSERT INTO RecipeSteps (Id, RecipeId, Position, Content)
                VALUES ('{Guid.NewGuid()}', '{recipeAId}', 0, 'Kneten.'),
                       ('{Guid.NewGuid()}', '{recipeAId}', 1, 'Backen.'),
                       ('{Guid.NewGuid()}', '{recipeBId}', 0, 'Mixen.');
                """;
            await cmd.ExecuteNonQueryAsync();
        }

        // Stage 3 — apply the COMP-0 migration.
        using (var target = CreateContext())
        {
            var migrator = target.GetInfrastructure().GetRequiredService<IMigrator>();
            await migrator.MigrateAsync(TargetMigration);
        }

        // Stage 4 — assert the backfill did its job.
        using var final = CreateContext();

        // Every recipe got exactly one default component (Label=NULL,
        // Position=0).
        var components = await final.RecipeComponents
            .AsNoTracking()
            .ToListAsync();
        Assert.Equal(2, components.Count);
        Assert.All(components, c => Assert.Null(c.Label));
        Assert.All(components, c => Assert.Equal(0, c.Position));

        var componentByRecipe = components.ToDictionary(c => c.RecipeId, c => c.Id);
        Assert.True(componentByRecipe.ContainsKey(recipeAId));
        Assert.True(componentByRecipe.ContainsKey(recipeBId));

        // Every ingredient + step now carries a non-null ComponentId
        // pointing at the right recipe's default component.
        var ingredients = await final.Ingredients.AsNoTracking().ToListAsync();
        Assert.Equal(3, ingredients.Count);
        foreach (var ing in ingredients)
        {
            Assert.Equal(componentByRecipe[ing.RecipeId], ing.ComponentId);
        }

        var steps = await final.RecipeSteps.AsNoTracking().ToListAsync();
        Assert.Equal(3, steps.Count);
        foreach (var step in steps)
        {
            Assert.Equal(componentByRecipe[step.RecipeId], step.ComponentId);
        }
    }
}
