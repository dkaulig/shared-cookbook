using FamilienKochbuch.Domain.Enums;
using FamilienKochbuch.Infrastructure.Persistence;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Xunit;

namespace FamilienKochbuch.Infrastructure.Tests.Services;

/// <summary>
/// Contract test for the AddRecipes migration's global tag seed: booting a
/// fresh DB via the real migration path (<see cref="DatabaseFacade.MigrateAsync"/>)
/// produces at least the 30 predefined tags and each of the six non-Custom
/// categories is represented.
/// </summary>
public class SeededTagsTests : IAsyncLifetime
{
    private SqliteConnection _connection = null!;
    private AppDbContext _db = null!;

    public async Task InitializeAsync()
    {
        _connection = new SqliteConnection("DataSource=:memory:");
        await _connection.OpenAsync();

        // The production model snapshot is generated against the Npgsql
        // provider (column types like "character varying"). Running
        // MigrateAsync against SQLite is valid — EF's provider translates
        // the types — but EF 10 raises PendingModelChangesWarning because
        // the SQLite-translated model hash differs from the snapshot. We
        // ignore that specific warning here; schema parity is still
        // exercised end-to-end against Postgres in docker-compose.
        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseSqlite(_connection)
            .ConfigureWarnings(w => w.Ignore(RelationalEventId.PendingModelChangesWarning))
            .Options;
        _db = new AppDbContext(options);
        await _db.Database.MigrateAsync();
    }

    public async Task DisposeAsync()
    {
        await _db.DisposeAsync();
        await _connection.DisposeAsync();
    }

    [Fact]
    public async Task At_Least_30_Global_Tags_Seeded()
    {
        var count = await _db.Tags
            .Where(t => t.GroupId == null && t.CreatedByUserId == null)
            .CountAsync();

        Assert.True(count >= 30, $"Expected at least 30 global tags, got {count}.");
    }

    [Fact]
    public async Task All_Non_Custom_Categories_Represented()
    {
        var categories = new[]
        {
            TagCategory.Mahlzeit,
            TagCategory.Saison,
            TagCategory.Typ,
            TagCategory.Aufwand,
            TagCategory.Diaet,
            TagCategory.Kueche,
        };

        foreach (var category in categories)
        {
            var present = await _db.Tags.AnyAsync(t => t.Category == category && t.GroupId == null);
            Assert.True(present, $"No seeded global tag for category {category}.");
        }
    }

    [Fact]
    public async Task Well_Known_Global_Tags_Present()
    {
        string[] expected =
        [
            "Frühstück", "Mittag", "Abend", "Snack", "Dessert",
            "Frühling", "Sommer", "Herbst", "Winter", "ganzjährig",
            "warm", "kalt", "deftig", "süß", "leicht",
            "schnell", "mittel", "aufwendig",
            "vegetarisch", "vegan", "glutenfrei", "laktosefrei",
            "deutsch", "italienisch", "asiatisch", "mexikanisch",
            "französisch", "spanisch", "indisch", "orientalisch",
        ];
        var seededNames = await _db.Tags
            .Where(t => t.GroupId == null)
            .Select(t => t.Name)
            .ToListAsync();

        foreach (var name in expected)
        {
            Assert.Contains(name, seededNames);
        }
    }

    [Fact]
    public async Task No_Custom_Category_Among_Seeds()
    {
        var customCount = await _db.Tags
            .CountAsync(t => t.Category == TagCategory.Custom && t.GroupId == null);
        Assert.Equal(0, customCount);
    }

    // GR1 — AddKomponenteTagCategory migration seeds exactly seven global
    // tags under the new Komponente category so users can mark isolated
    // sub-recipes (Pizzateig, Tomatensauce, Dressings …). The seed is
    // idempotent — re-running the migration produces the same rows —
    // because each row has a stable GUID.

    [Fact]
    public async Task Seven_Komponente_Tags_Seeded()
    {
        var count = await _db.Tags
            .Where(t => t.Category == TagCategory.Komponente && t.GroupId == null)
            .CountAsync();

        Assert.Equal(7, count);
    }

    [Fact]
    public async Task Komponente_Tag_Names_Match_GR1_Spec()
    {
        string[] expected =
        [
            "Grundrezept",
            "Teig",
            "Sauce",
            "Glasur",
            "Dressing",
            "Beilage",
            "Topping",
        ];

        var seededNames = await _db.Tags
            .Where(t => t.Category == TagCategory.Komponente && t.GroupId == null)
            .Select(t => t.Name)
            .OrderBy(n => n)
            .ToListAsync();

        Assert.Equal(expected.OrderBy(n => n), seededNames);
    }

    [Fact]
    public async Task Komponente_Seed_Uses_Stable_Guids()
    {
        // Stable GUIDs stamped by the AddKomponenteTagCategory migration.
        // Pinned here so future "regenerate migration" mistakes that
        // swap to Guid.NewGuid() are caught — stable ids are what makes
        // re-running the seed idempotent on an already-seeded DB.
        var expected = new Dictionary<string, Guid>
        {
            ["Grundrezept"] = Guid.Parse("a0000007-0000-0000-0000-000000000001"),
            ["Teig"] = Guid.Parse("a0000007-0000-0000-0000-000000000002"),
            ["Sauce"] = Guid.Parse("a0000007-0000-0000-0000-000000000003"),
            ["Glasur"] = Guid.Parse("a0000007-0000-0000-0000-000000000004"),
            ["Dressing"] = Guid.Parse("a0000007-0000-0000-0000-000000000005"),
            ["Beilage"] = Guid.Parse("a0000007-0000-0000-0000-000000000006"),
            ["Topping"] = Guid.Parse("a0000007-0000-0000-0000-000000000007"),
        };

        var seeded = await _db.Tags
            .Where(t => t.Category == TagCategory.Komponente && t.GroupId == null)
            .ToDictionaryAsync(t => t.Name, t => t.Id);

        foreach (var (name, id) in expected)
        {
            Assert.True(seeded.ContainsKey(name), $"Missing Komponente seed '{name}'.");
            Assert.Equal(id, seeded[name]);
        }
    }

    [Fact]
    public async Task At_Least_37_Global_Tags_Seeded_After_GR1()
    {
        // 30 pre-GR1 seeds + 7 Komponente seeds = 37. The existing
        // "at least 30" test keeps working too, but we pin the post-GR1
        // floor so a future drop of the Komponente seed is caught.
        var count = await _db.Tags
            .Where(t => t.GroupId == null && t.CreatedByUserId == null)
            .CountAsync();

        Assert.True(count >= 37, $"Expected at least 37 global tags after GR1, got {count}.");
    }
}
