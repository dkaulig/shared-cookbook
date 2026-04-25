using SharedCookbook.Domain.Entities;
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
/// CFG-0 — contract test for the <c>20260421213639_AddExtractorConfig</c>
/// migration's seed. Boots a fresh SQLite DB, applies up to the CFG-0
/// migration, and asserts every key registered in
/// <see cref="ExtractorConfigDefaults"/> is present with the expected
/// default JSON payload and <see cref="ExtractorConfigValueType"/>.
/// Seed rows must carry <c>UpdatedBy = NULL</c> + <c>Version = 0</c>
/// so the admin UI's "never touched by a human" signal works.
/// </summary>
public class AddExtractorConfigMigrationTests : IAsyncLifetime
{
    private const string TargetMigration = "20260421213639_AddExtractorConfig";

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
    public async Task Migration_Seeds_Every_Registered_Key_With_Default_Value_And_Type()
    {
        using (var ctx = CreateContext())
        {
            var migrator = ctx.GetInfrastructure().GetRequiredService<IMigrator>();
            await migrator.MigrateAsync(TargetMigration);
        }

        using var final = CreateContext();
        var rows = await final.ExtractorConfigs
            .AsNoTracking()
            .ToDictionaryAsync(r => r.Key, r => r);

        Assert.Equal(ExtractorConfigDefaults.All.Count, rows.Count);

        foreach (var expected in ExtractorConfigDefaults.All)
        {
            Assert.True(
                rows.TryGetValue(expected.Key, out var row),
                $"Expected seeded key '{expected.Key}' missing from ExtractorConfig.");
            Assert.Equal(expected.DefaultValueJson, row!.ValueJson);
            Assert.Equal(expected.ValueType, row.ValueType);
            Assert.Equal(0, row.Version);
            Assert.Null(row.UpdatedBy);
        }
    }

    [Fact]
    public async Task Migration_Seeds_All_Feature_Flags_As_True()
    {
        using (var ctx = CreateContext())
        {
            var migrator = ctx.GetInfrastructure().GetRequiredService<IMigrator>();
            await migrator.MigrateAsync(TargetMigration);
        }

        using var final = CreateContext();
        var flagRows = await final.ExtractorConfigs
            .AsNoTracking()
            .Where(c => c.Key.StartsWith("feature."))
            .ToListAsync();

        Assert.NotEmpty(flagRows);
        foreach (var row in flagRows)
        {
            Assert.Equal(ExtractorConfigValueType.Bool, row.ValueType);
            Assert.Equal("true", row.ValueJson);
        }
    }

    [Fact]
    public async Task Migration_Seeds_Shortener_Hosts_As_Json_Array()
    {
        using (var ctx = CreateContext())
        {
            var migrator = ctx.GetInfrastructure().GetRequiredService<IMigrator>();
            await migrator.MigrateAsync(TargetMigration);
        }

        using var final = CreateContext();
        var row = await final.ExtractorConfigs
            .AsNoTracking()
            .SingleAsync(c => c.Key == "pipeline.shortener_hosts");

        Assert.Equal(ExtractorConfigValueType.StringList, row.ValueType);
        Assert.Contains("bit.ly", row.ValueJson);
        Assert.Contains("tinyurl.com", row.ValueJson);
    }

    [Fact]
    public async Task Migration_Creates_Empty_History_Table()
    {
        using (var ctx = CreateContext())
        {
            var migrator = ctx.GetInfrastructure().GetRequiredService<IMigrator>();
            await migrator.MigrateAsync(TargetMigration);
        }

        using var final = CreateContext();
        var historyCount = await final.ExtractorConfigHistories.AsNoTracking().CountAsync();
        Assert.Equal(0, historyCount);
    }
}
