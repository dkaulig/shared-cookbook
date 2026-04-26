using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace SharedCookbook.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// CFG-1 — bring already-deployed prod rows in line with the v0.15.2
    /// truncation fix. The Python-side hardcoded fallback constant for
    /// <c>max_completion_tokens</c> was bumped from <c>2048</c> →
    /// <c>4096</c> in v0.15.2, but the CFG-1 reader pulls the live value
    /// from the API's DB-backed registry whose seed (CFG-0,
    /// <c>20260421213639_AddExtractorConfig</c>) was still <c>2048</c>.
    /// In any prod DB whose CFG-0 seed had already run, the cap stayed
    /// at <c>2048</c> and the truncation reproduced.
    ///
    /// <para>
    /// <b>Idempotent + admin-safe.</b> The <c>WHERE "Value" = '2048'</c>
    /// clause:
    /// <list type="bullet">
    ///   <item>Skips rows the admin already overrode to anything else
    ///   (e.g. someone bumped to 6000 manually via /admin/extractor —
    ///   that override survives untouched).</item>
    ///   <item>Skips rows on a fresh deploy whose CFG-0 seed already
    ///   carries the post-bump default of <c>4096</c>.</item>
    ///   <item>Is a no-op on a re-run.</item>
    /// </list>
    /// </para>
    ///
    /// <para>
    /// The <c>Down</c> direction reverses only the rows we set: any row
    /// currently at <c>4096</c> drops back to <c>2048</c>. Admin-set
    /// non-default values stay where they are.
    /// </para>
    /// </summary>
    public partial class BumpExtractorConfigMaxTokensTo4096 : Migration
    {
        private const string NpgsqlProvider = "Npgsql.EntityFrameworkCore.PostgreSQL";
        private const string SqliteProvider = "Microsoft.EntityFrameworkCore.Sqlite";

        private static readonly string[] AffectedKeys =
        {
            "llm.structured.max_completion_tokens",
            "llm.chat.max_completion_tokens",
            "llm.vision.max_completion_tokens",
        };

        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            UpdateValue(migrationBuilder, fromValue: "2048", toValue: "4096");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            UpdateValue(migrationBuilder, fromValue: "4096", toValue: "2048");
        }

        /// <summary>
        /// Issue one <c>UPDATE</c> per affected key, gated on the current
        /// value matching <paramref name="fromValue"/>. Postgres uses the
        /// quoted-identifier casing + <c>::jsonb</c> casts that the CFG-0
        /// migration established; SQLite uses the same identifiers
        /// without the cast (TEXT-affinity column).
        /// </summary>
        private static void UpdateValue(MigrationBuilder migrationBuilder, string fromValue, string toValue)
        {
            foreach (var key in AffectedKeys)
            {
                if (migrationBuilder.ActiveProvider == NpgsqlProvider)
                {
                    migrationBuilder.Sql($"""
                        UPDATE "ExtractorConfig"
                           SET "ValueJson" = '{toValue}'::jsonb,
                               "UpdatedAt" = NOW(),
                               "Version"   = "Version" + 1
                         WHERE "Key" = '{key}'
                           AND "ValueJson" = '{fromValue}'::jsonb;
                        """);
                }
                else if (migrationBuilder.ActiveProvider == SqliteProvider)
                {
                    migrationBuilder.Sql($"""
                        UPDATE ExtractorConfig
                           SET ValueJson = '{toValue}',
                               UpdatedAt = CURRENT_TIMESTAMP,
                               Version   = Version + 1
                         WHERE Key = '{key}'
                           AND ValueJson = '{fromValue}';
                        """);
                }
            }
        }
    }
}
