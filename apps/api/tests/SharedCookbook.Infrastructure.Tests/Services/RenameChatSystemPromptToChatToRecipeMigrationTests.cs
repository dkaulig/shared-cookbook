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
/// <c>20260426212430_RenameChatSystemPromptToChatToRecipe</c> migration.
///
/// <para>
/// The registry key <c>llm.chat.system_prompt</c> is misnamed: editing
/// it via the admin UI affects the chat-to-recipe extraction pipeline
/// (Whisper transcript → structured recipe), not the conversational
/// chat assistant whose prompt now lives in C# (<see
/// cref="SharedCookbook.Api.Services.ChatSystemPrompt"/>). The
/// migration renames the key to <c>llm.chat_to_recipe.system_prompt</c>
/// in place — preserving any admin-edited <c>ValueJson</c>, bumping
/// <c>Version</c> + stamping <c>UpdatedAt</c> so optimistic-concurrency-
/// aware admin endpoints see a fresh snapshot.
/// </para>
///
/// <para>
/// Mirrors the locking style used in
/// <see cref="BumpExtractorConfigMaxTokensTo4096MigrationTests"/>: an
/// in-memory SQLite DB applied through the EF Core migrator rather
/// than the model-snapshot path, so the actual SQL the migration emits
/// runs against a real engine.
/// </para>
/// </summary>
public class RenameChatSystemPromptToChatToRecipeMigrationTests : IAsyncLifetime
{
    private const string PreviousMigration = "20260426205543_BumpExtractorConfigMaxTokensTo4096";
    private const string TargetMigration = "20260426212430_RenameChatSystemPromptToChatToRecipe";

    private const string OldKey = "llm.chat.system_prompt";
    private const string NewKey = "llm.chat_to_recipe.system_prompt";

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
    /// Replace the key on the row that was seeded under
    /// <see cref="OldKey"/>. Used to simulate the prod state where the
    /// CFG-0 migration ran with the old <c>llm.chat.system_prompt</c>
    /// default before the rename landed (the source rename is already
    /// in place locally, so without this fixup the row already carries
    /// the new key after CFG-0 seeds).
    /// </summary>
    private async Task ResetKeyToOldAsync()
    {
        await using var cmd = _connection.CreateCommand();
        cmd.CommandText =
            "UPDATE ExtractorConfig SET Key = $oldKey WHERE Key = $newKey;";
        cmd.Parameters.AddWithValue("$oldKey", OldKey);
        cmd.Parameters.AddWithValue("$newKey", NewKey);
        await cmd.ExecuteNonQueryAsync();
    }

    private async Task SetValueJsonAsync(string key, string valueJson)
    {
        await using var cmd = _connection.CreateCommand();
        cmd.CommandText = "UPDATE ExtractorConfig SET ValueJson = $value WHERE Key = $key;";
        cmd.Parameters.AddWithValue("$value", valueJson);
        cmd.Parameters.AddWithValue("$key", key);
        await cmd.ExecuteNonQueryAsync();
    }

    private async Task<(string ValueJson, int Version)?> ReadRowAsync(string key)
    {
        await using var cmd = _connection.CreateCommand();
        cmd.CommandText =
            "SELECT CAST(ValueJson AS TEXT), Version FROM ExtractorConfig WHERE Key = $key;";
        cmd.Parameters.AddWithValue("$key", key);
        await using var reader = await cmd.ExecuteReaderAsync();
        if (!await reader.ReadAsync()) return null;
        return ((string)reader.GetValue(0), reader.GetInt32(1));
    }

    [Fact]
    public async Task RenameChatSystemPrompt_Up_Renames_Existing_Row()
    {
        // Stage 1 — migrate to the previous head; restore the old-key
        // shape (CFG-0 was renamed at source so the row currently lives
        // under the new key locally) and set an "admin-edited" payload
        // we can prove survives the rename.
        await MigrateToAsync(PreviousMigration);
        await ResetKeyToOldAsync();
        const string adminEdit = "\"Admin hat den Chat-zu-Rezept-Prompt schon angepasst.\"";
        await SetValueJsonAsync(OldKey, adminEdit);

        // Stage 2 — apply the rename migration.
        await MigrateToAsync(TargetMigration);

        // Stage 3 — old key is gone, new key carries the unchanged value.
        Assert.Null(await ReadRowAsync(OldKey));
        var renamed = await ReadRowAsync(NewKey);
        Assert.NotNull(renamed);
        Assert.Equal(adminEdit, renamed!.Value.ValueJson);
    }

    [Fact]
    public async Task RenameChatSystemPrompt_Up_Bumps_Version_So_Admin_Refetches()
    {
        // Stage 1 — old-key shape, default seeded Version=0 from CFG-0.
        await MigrateToAsync(PreviousMigration);
        await ResetKeyToOldAsync();
        var before = await ReadRowAsync(OldKey);
        Assert.NotNull(before);
        Assert.Equal(0, before!.Value.Version);

        // Stage 2 — apply the rename migration.
        await MigrateToAsync(TargetMigration);

        // Stage 3 — version bumped to 1 so optimistic-concurrency-aware
        // admin endpoints pick up a fresh snapshot on the next refetch.
        var after = await ReadRowAsync(NewKey);
        Assert.NotNull(after);
        Assert.Equal(1, after!.Value.Version);
    }

    [Fact]
    public async Task RenameChatSystemPrompt_Down_Reverses_The_Rename()
    {
        // Stage 1 — apply Up so the row carries the new key; pin a
        // distinctive value we can recognise after Down.
        await MigrateToAsync(PreviousMigration);
        await ResetKeyToOldAsync();
        await MigrateToAsync(TargetMigration);
        const string adminEdit = "\"Reversibel: Down soll Key zurückbenennen, Wert beibehalten.\"";
        await SetValueJsonAsync(NewKey, adminEdit);

        // Stage 2 — roll back via Down.
        await MigrateToAsync(PreviousMigration);

        // Stage 3 — new key gone, old key restored, value preserved.
        Assert.Null(await ReadRowAsync(NewKey));
        var rolled = await ReadRowAsync(OldKey);
        Assert.NotNull(rolled);
        Assert.Equal(adminEdit, rolled!.Value.ValueJson);
    }
}
