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
/// CFG-1 — contract test for the
/// <c>20260426205543_BumpExtractorConfigMaxTokensTo4096</c> migration.
///
/// <para>
/// In v0.15.2 the Python-side fallback constant for
/// <c>max_completion_tokens</c> was bumped from <c>2048</c> →
/// <c>4096</c> to fix Azure-side truncation, but the CFG-1 reader
/// pulls the live value from the API's DB-backed registry whose seed
/// was still <c>2048</c>. This migration brings already-deployed prod
/// rows up to <c>4096</c> while preserving any admin-set override
/// (the WHERE clause requires the existing value to be exactly
/// <c>'2048'</c>).
/// </para>
///
/// <para>
/// The test runs against an in-memory SQLite DB to keep parity with
/// the rest of the migration test harness. The migration explicitly
/// supports the SQLite syntax in addition to Postgres so the
/// invariant ("only update untouched 2048 rows; admin overrides
/// untouched") can be verified against a real DB.
/// </para>
/// </summary>
public class BumpExtractorConfigMaxTokensTo4096MigrationTests : IAsyncLifetime
{
    private const string PreviousMigration = "20260425070540_AddRecipeTranslationsTable";
    private const string TargetMigration = "20260426205543_BumpExtractorConfigMaxTokensTo4096";

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

    private async Task MigrateToAsync(string migration)
    {
        using var ctx = CreateContext();
        var migrator = ctx.GetInfrastructure().GetRequiredService<IMigrator>();
        await migrator.MigrateAsync(migration);
    }

    /// <summary>
    /// Replace the seed-time ValueJson for one config row with the
    /// supplied literal. Used to simulate the prod state where the
    /// original CFG-0 migration ran with the old "2048" defaults
    /// (the source bump is already in place locally).
    /// </summary>
    private async Task SetExtractorConfigValueAsync(string key, string valueJson)
    {
        await using var cmd = _connection.CreateCommand();
        cmd.CommandText = "UPDATE ExtractorConfig SET ValueJson = $value WHERE Key = $key;";
        cmd.Parameters.AddWithValue("$value", valueJson);
        cmd.Parameters.AddWithValue("$key", key);
        await cmd.ExecuteNonQueryAsync();
    }

    private async Task<string> GetExtractorConfigValueAsync(string key)
    {
        await using var cmd = _connection.CreateCommand();
        // CAST to TEXT — SQLite's jsonb column type maps to NUMERIC
        // affinity, so a row whose payload is "2048" comes back as
        // System.Int64. The CFG-1 reader pulls a string and parses it
        // (the JSON literal can be int / float / quoted string), so
        // assert against the textual form.
        cmd.CommandText = "SELECT CAST(ValueJson AS TEXT) FROM ExtractorConfig WHERE Key = $key;";
        cmd.Parameters.AddWithValue("$key", key);
        var result = await cmd.ExecuteScalarAsync();
        return (string)result!;
    }

    [Fact]
    public async Task Up_Migrates_2048_Rows_To_4096_For_All_Three_Keys()
    {
        // Stage 1 — migrate to the previous head, then reset the three
        // max_completion_tokens rows to "2048" to simulate a prod DB
        // that was originally seeded by the v0.11.0 CFG-0 migration.
        await MigrateToAsync(PreviousMigration);
        await SetExtractorConfigValueAsync("llm.structured.max_completion_tokens", "2048");
        await SetExtractorConfigValueAsync("llm.chat.max_completion_tokens", "2048");
        await SetExtractorConfigValueAsync("llm.vision.max_completion_tokens", "2048");

        // Stage 2 — apply the bump migration.
        await MigrateToAsync(TargetMigration);

        // Stage 3 — assert all three rows are now "4096".
        Assert.Equal("4096", await GetExtractorConfigValueAsync("llm.structured.max_completion_tokens"));
        Assert.Equal("4096", await GetExtractorConfigValueAsync("llm.chat.max_completion_tokens"));
        Assert.Equal("4096", await GetExtractorConfigValueAsync("llm.vision.max_completion_tokens"));
    }

    [Fact]
    public async Task Up_Preserves_Admin_Set_Non_Default_Values()
    {
        // Admin already bumped the structured cap manually to 8000
        // via /admin/extractor — that override must NOT be clobbered.
        await MigrateToAsync(PreviousMigration);
        await SetExtractorConfigValueAsync("llm.structured.max_completion_tokens", "8000");
        await SetExtractorConfigValueAsync("llm.chat.max_completion_tokens", "2048");
        await SetExtractorConfigValueAsync("llm.vision.max_completion_tokens", "2048");

        await MigrateToAsync(TargetMigration);

        // Admin override survives unchanged.
        Assert.Equal("8000", await GetExtractorConfigValueAsync("llm.structured.max_completion_tokens"));
        // The other two roll forward from default → new default.
        Assert.Equal("4096", await GetExtractorConfigValueAsync("llm.chat.max_completion_tokens"));
        Assert.Equal("4096", await GetExtractorConfigValueAsync("llm.vision.max_completion_tokens"));
    }

    [Fact]
    public async Task Up_Is_Idempotent_When_Rerun_Against_Already_Migrated_Rows()
    {
        // Defence-in-depth: a row already at "4096" (because the source
        // bump shipped before the migration ran, or the migration ran
        // twice) is a no-op. The WHERE clause filters on Value = '2048'
        // so a second pass touches nothing.
        await MigrateToAsync(PreviousMigration);
        await SetExtractorConfigValueAsync("llm.structured.max_completion_tokens", "4096");

        await MigrateToAsync(TargetMigration);

        Assert.Equal("4096", await GetExtractorConfigValueAsync("llm.structured.max_completion_tokens"));
    }
}
