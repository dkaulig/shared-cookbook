using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace SharedCookbook.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// CFG-1 — rename the misnamed registry key
    /// <c>llm.chat.system_prompt</c> → <c>llm.chat_to_recipe.system_prompt</c>.
    ///
    /// <para>
    /// Editing the row through <c>/admin/extractor</c> never affected the
    /// conversational chat assistant — that prompt lives in C#
    /// (<c>SharedCookbook.Api.Services.ChatSystemPrompt.BasePrompt</c>)
    /// post-CR5 and does not consume CFG-1. The row's <em>actual</em>
    /// audience is the chat-to-recipe extraction pipeline (Whisper
    /// transcript → structured recipe), so the new key reflects that.
    /// </para>
    ///
    /// <para>
    /// <b>Rename in place — admin edits survive.</b> The migration
    /// issues a <c>UPDATE … SET "Key" = …</c>, NOT a delete+insert, so
    /// any prompt content the admin already saved stays in the
    /// <c>ValueJson</c> column. <c>Version</c> is bumped + <c>UpdatedAt</c>
    /// stamped so the optimistic-concurrency-aware admin endpoints see
    /// a fresh snapshot on the next refetch and a stale baseline in an
    /// open admin tab fails-closed with the standard 409 banner instead
    /// of writing through.
    /// </para>
    ///
    /// <para>
    /// Branched per provider in the same shape as the prior CFG-1
    /// migration <c>20260426205543_BumpExtractorConfigMaxTokensTo4096</c>:
    /// Postgres uses quoted identifiers + <c>NOW()</c>, SQLite the bare
    /// names + <c>CURRENT_TIMESTAMP</c>. Both sides of the rename are
    /// static literals — no user input flows into the SQL — so this is
    /// not an injection surface.
    /// </para>
    /// </summary>
    public partial class RenameChatSystemPromptToChatToRecipe : Migration
    {
        private const string NpgsqlProvider = "Npgsql.EntityFrameworkCore.PostgreSQL";
        private const string SqliteProvider = "Microsoft.EntityFrameworkCore.Sqlite";

        private const string OldKey = "llm.chat.system_prompt";
        private const string NewKey = "llm.chat_to_recipe.system_prompt";

        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            RenameKey(migrationBuilder, fromKey: OldKey, toKey: NewKey);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            RenameKey(migrationBuilder, fromKey: NewKey, toKey: OldKey);
        }

        /// <summary>
        /// Issue one <c>UPDATE … SET "Key" = …</c> against the registry,
        /// gated on the current key matching <paramref name="fromKey"/>.
        /// Bumps <c>Version</c> + stamps <c>UpdatedAt</c> so a stale admin
        /// baseline cleanly fails the next concurrency check.
        /// </summary>
        private static void RenameKey(MigrationBuilder migrationBuilder, string fromKey, string toKey)
        {
            if (migrationBuilder.ActiveProvider == NpgsqlProvider)
            {
                migrationBuilder.Sql($"""
                    UPDATE "ExtractorConfig"
                       SET "Key"       = '{toKey}',
                           "UpdatedAt" = NOW(),
                           "Version"   = "Version" + 1
                     WHERE "Key" = '{fromKey}';
                    """);
            }
            else if (migrationBuilder.ActiveProvider == SqliteProvider)
            {
                migrationBuilder.Sql($"""
                    UPDATE ExtractorConfig
                       SET Key       = '{toKey}',
                           UpdatedAt = CURRENT_TIMESTAMP,
                           Version   = Version + 1
                     WHERE Key = '{fromKey}';
                    """);
            }
        }
    }
}
