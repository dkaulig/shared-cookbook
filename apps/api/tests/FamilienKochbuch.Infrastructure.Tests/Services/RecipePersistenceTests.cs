using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.Enums;
using FamilienKochbuch.Infrastructure.Persistence;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace FamilienKochbuch.Infrastructure.Tests.Services;

/// <summary>
/// Persistence-level tests for the Recipe aggregate: composite-position
/// uniqueness, cascade-delete from Recipe to its Ingredients/Steps/RecipeTags,
/// and tag-index uniqueness. SQLite in-memory backs every test.
/// </summary>
public class RecipePersistenceTests : IAsyncLifetime
{
    private SqliteConnection _connection = null!;
    private AppDbContext _db = null!;
    private Guid _groupId;
    private Guid _userId;

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
        user.SetEmail("tester@example.com");
        var group = new Group("Familie", null, DateTimeOffset.UtcNow);
        _db.Users.Add(user);
        _db.Groups.Add(group);
        await _db.SaveChangesAsync();

        _userId = user.Id;
        _groupId = group.Id;
    }

    public async Task DisposeAsync()
    {
        await _db.DisposeAsync();
        await _connection.DisposeAsync();
    }

    private Recipe AddSimpleRecipe()
    {
        var recipe = new Recipe(
            groupId: _groupId,
            createdByUserId: _userId,
            title: "Kartoffelsalat",
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
    public async Task Recipe_With_Ingredients_And_Steps_Round_Trips()
    {
        var recipe = AddSimpleRecipe();
        recipe.Ingredients.Add(new Ingredient(recipe.Id, 0, 500m, "g", "Kartoffeln", null, true));
        recipe.Ingredients.Add(new Ingredient(recipe.Id, 1, null, "Prise", "Salz", null, false));
        recipe.Steps.Add(new RecipeStep(recipe.Id, 0, "Kartoffeln kochen."));
        recipe.Steps.Add(new RecipeStep(recipe.Id, 1, "Abgießen."));
        await _db.SaveChangesAsync();

        var reloaded = await _db.Recipes
            .Include(r => r.Ingredients)
            .Include(r => r.Steps)
            .SingleAsync(r => r.Id == recipe.Id);

        Assert.Equal(2, reloaded.Ingredients.Count);
        Assert.Equal(2, reloaded.Steps.Count);
        Assert.Contains(reloaded.Ingredients, i => i.Name == "Salz" && !i.Scalable);
    }

    [Fact]
    public async Task Ingredient_Position_Is_Unique_Per_Recipe()
    {
        var recipe = AddSimpleRecipe();
        recipe.Ingredients.Add(new Ingredient(recipe.Id, 0, 500m, "g", "Kartoffeln", null, true));
        recipe.Ingredients.Add(new Ingredient(recipe.Id, 0, 2m, "", "Eier", null, true));

        await Assert.ThrowsAnyAsync<DbUpdateException>(() => _db.SaveChangesAsync());
    }

    [Fact]
    public async Task RecipeStep_Position_Is_Unique_Per_Recipe()
    {
        var recipe = AddSimpleRecipe();
        recipe.Steps.Add(new RecipeStep(recipe.Id, 0, "Kochen."));
        recipe.Steps.Add(new RecipeStep(recipe.Id, 0, "Dup-Position."));

        await Assert.ThrowsAnyAsync<DbUpdateException>(() => _db.SaveChangesAsync());
    }

    [Fact]
    public async Task Deleting_Recipe_Cascades_To_Ingredients_Steps_And_RecipeTags()
    {
        var tag = Tag.CreateGlobal("schnell", TagCategory.Aufwand);
        _db.Tags.Add(tag);

        var recipe = AddSimpleRecipe();
        recipe.Ingredients.Add(new Ingredient(recipe.Id, 0, 500m, "g", "Kartoffeln", null, true));
        recipe.Steps.Add(new RecipeStep(recipe.Id, 0, "Kochen."));
        await _db.SaveChangesAsync();

        _db.RecipeTags.Add(new RecipeTag(recipe.Id, tag.Id));
        await _db.SaveChangesAsync();

        _db.Recipes.Remove(recipe);
        await _db.SaveChangesAsync();

        Assert.Empty(await _db.Ingredients.Where(i => i.RecipeId == recipe.Id).ToListAsync());
        Assert.Empty(await _db.RecipeSteps.Where(s => s.RecipeId == recipe.Id).ToListAsync());
        Assert.Empty(await _db.RecipeTags.Where(t => t.RecipeId == recipe.Id).ToListAsync());

        // Tag itself is not deleted when the recipe goes away.
        Assert.Single(await _db.Tags.Where(t => t.Id == tag.Id).ToListAsync());
    }

    [Fact]
    public async Task Deleting_Tag_Cascades_To_RecipeTags()
    {
        var tag = Tag.CreateGlobal("vegan", TagCategory.Diaet);
        _db.Tags.Add(tag);

        var recipe = AddSimpleRecipe();
        await _db.SaveChangesAsync();
        _db.RecipeTags.Add(new RecipeTag(recipe.Id, tag.Id));
        await _db.SaveChangesAsync();

        _db.Tags.Remove(tag);
        await _db.SaveChangesAsync();

        Assert.Empty(await _db.RecipeTags.Where(t => t.TagId == tag.Id).ToListAsync());
        Assert.NotNull(await _db.Recipes.SingleOrDefaultAsync(r => r.Id == recipe.Id));
    }

    [Fact]
    public async Task Group_Scoped_Tag_Uniqueness_Prevents_Duplicate_Within_Group()
    {
        // Group-scoped tags with the same (Name, Category, GroupId) must
        // collide via the unique index — both GroupId values are non-null so
        // Postgres/SQLite treat them as equal. Global-tag duplicates
        // (GroupId == NULL on both) slip past the unique index because of
        // default "NULLS DISTINCT" semantics; the seed migration uses stable
        // GUIDs + ON CONFLICT-style dedup to keep the global catalog clean.
        _db.Tags.Add(Tag.CreateGroupScoped(_userId, _groupId, "Omas Rezepte"));
        await _db.SaveChangesAsync();

        _db.Tags.Add(Tag.CreateGroupScoped(_userId, _groupId, "Omas Rezepte"));

        await Assert.ThrowsAnyAsync<DbUpdateException>(() => _db.SaveChangesAsync());
    }

    [Fact]
    public async Task Same_Tag_Name_Allowed_Across_Categories()
    {
        _db.Tags.Add(Tag.CreateGlobal("leicht", TagCategory.Typ));
        _db.Tags.Add(Tag.CreateGlobal("leicht", TagCategory.Aufwand));
        await _db.SaveChangesAsync();

        Assert.Equal(2, await _db.Tags.CountAsync(t => t.Name == "leicht"));
    }

    [Fact]
    public async Task Group_Scoped_Tag_Can_Share_Name_With_Global()
    {
        _db.Tags.Add(Tag.CreateGlobal("Omas Rezepte", TagCategory.Custom));
        await _db.SaveChangesAsync();

        _db.Tags.Add(Tag.CreateGroupScoped(_userId, _groupId, "Omas Rezepte"));
        await _db.SaveChangesAsync();

        Assert.Equal(2, await _db.Tags.CountAsync(t => t.Name == "Omas Rezepte"));
    }

    [Fact]
    public async Task Photos_Round_Trip_Through_Storage()
    {
        var recipe = AddSimpleRecipe();
        recipe.AddPhoto("https://example.com/a.jpg");
        recipe.AddPhoto("https://example.com/b.jpg");
        await _db.SaveChangesAsync();

        using var fresh = new AppDbContext(
            new DbContextOptionsBuilder<AppDbContext>().UseSqlite(_connection).Options);
        var reloaded = await fresh.Recipes.SingleAsync(r => r.Id == recipe.Id);

        Assert.Equal(2, reloaded.Photos.Count);
        Assert.Equal("https://example.com/a.jpg", reloaded.Photos[0]);
        Assert.Equal("https://example.com/b.jpg", reloaded.Photos[1]);
    }

    // ── P2-10 — Nutrition estimate persistence ─────────────────────────

    [Fact]
    public async Task NutritionEstimate_Round_Trips_When_Set()
    {
        var recipe = AddSimpleRecipe();
        recipe.SetNutritionEstimate(
            new NutritionEstimate(Kcal: 420, ProteinG: 24, CarbsG: 38, FatG: 9),
            DateTimeOffset.UtcNow);
        await _db.SaveChangesAsync();

        using var fresh = new AppDbContext(
            new DbContextOptionsBuilder<AppDbContext>().UseSqlite(_connection).Options);
        var reloaded = await fresh.Recipes.SingleAsync(r => r.Id == recipe.Id);

        Assert.NotNull(reloaded.NutritionEstimate);
        Assert.Equal(420, reloaded.NutritionEstimate!.Kcal);
        Assert.Equal(24, reloaded.NutritionEstimate.ProteinG);
        Assert.Equal(38, reloaded.NutritionEstimate.CarbsG);
        Assert.Equal(9, reloaded.NutritionEstimate.FatG);
    }

    [Fact]
    public async Task NutritionEstimate_Defaults_To_Null()
    {
        var recipe = AddSimpleRecipe();
        await _db.SaveChangesAsync();

        using var fresh = new AppDbContext(
            new DbContextOptionsBuilder<AppDbContext>().UseSqlite(_connection).Options);
        var reloaded = await fresh.Recipes.SingleAsync(r => r.Id == recipe.Id);

        Assert.Null(reloaded.NutritionEstimate);
    }

    [Fact]
    public async Task NutritionEstimate_Can_Be_Cleared()
    {
        var recipe = AddSimpleRecipe();
        recipe.SetNutritionEstimate(
            new NutritionEstimate(300, 10, 30, 8), DateTimeOffset.UtcNow);
        await _db.SaveChangesAsync();

        recipe.SetNutritionEstimate(null, DateTimeOffset.UtcNow);
        await _db.SaveChangesAsync();

        using var fresh = new AppDbContext(
            new DbContextOptionsBuilder<AppDbContext>().UseSqlite(_connection).Options);
        var reloaded = await fresh.Recipes.SingleAsync(r => r.Id == recipe.Id);

        Assert.Null(reloaded.NutritionEstimate);
    }
}
