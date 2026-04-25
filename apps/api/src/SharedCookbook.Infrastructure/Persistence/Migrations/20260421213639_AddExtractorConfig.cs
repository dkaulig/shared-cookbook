using System;
using SharedCookbook.Domain.Entities;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace SharedCookbook.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// CFG-0 — introduce the <c>ExtractorConfig</c> + <c>ExtractorConfigHistory</c>
    /// tables + seed every registered key with its hardcoded Python default
    /// (see <see cref="ExtractorConfigDefaults"/>).
    ///
    /// <para>
    /// Seed rows use <c>UpdatedBy = NULL</c> + <c>Version = 0</c> so the
    /// admin UI can distinguish "never touched by a human" from a real
    /// admin edit. The seed INSERTs are idempotent via <c>ON CONFLICT</c>
    /// (Postgres) / <c>INSERT OR IGNORE</c> (SQLite) so a re-run of the
    /// migration in a non-transactional environment doesn't duplicate
    /// rows.
    /// </para>
    ///
    /// <para>
    /// <b>Prompt placeholders.</b> The three <c>*.system_prompt</c> keys
    /// seed a short placeholder string — the CFG-1 Python slice overwrites
    /// these with the authoritative prompts via a one-time startup sync
    /// the first time the extractor starts up against a DB still carrying
    /// the placeholder. Rationale is documented on
    /// <see cref="ExtractorConfigDefaults"/>.
    /// </para>
    /// </summary>
    public partial class AddExtractorConfig : Migration
    {
        private const string NpgsqlProvider = "Npgsql.EntityFrameworkCore.PostgreSQL";
        private const string SqliteProvider = "Microsoft.EntityFrameworkCore.Sqlite";

        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "ExtractorConfig",
                columns: table => new
                {
                    Key = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    ValueJson = table.Column<string>(type: "jsonb", nullable: false),
                    ValueType = table.Column<int>(type: "integer", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    UpdatedBy = table.Column<Guid>(type: "uuid", nullable: true),
                    Version = table.Column<int>(type: "integer", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ExtractorConfig", x => x.Key);
                });

            migrationBuilder.CreateTable(
                name: "ExtractorConfigHistory",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Key = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    OldValueJson = table.Column<string>(type: "jsonb", nullable: false),
                    NewValueJson = table.Column<string>(type: "jsonb", nullable: false),
                    ChangedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    ChangedBy = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ExtractorConfigHistory", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_ExtractorConfigHistory_Key_ChangedAt",
                table: "ExtractorConfigHistory",
                columns: new[] { "Key", "ChangedAt" },
                descending: new[] { false, true });

            // ── Seed all registered keys with hardcoded defaults ──
            // One seed timestamp so the admin UI's "UpdatedAt" column
            // shows the install time for every untouched row (instead of
            // a per-row drift that depends on INSERT ordering). The
            // literal UTC timestamp matches the migration's file prefix
            // so an operator grepping either lines it up with the rest.
            const string seedTimestamp = "2026-04-21T21:36:39+00:00";

            foreach (var entry in ExtractorConfigDefaults.All)
            {
                var keyLiteral = SqlString(entry.Key);
                var valueLiteral = SqlString(entry.DefaultValueJson);
                var typeInt = (int)entry.ValueType;

                if (migrationBuilder.ActiveProvider == NpgsqlProvider)
                {
                    migrationBuilder.Sql($"""
                        INSERT INTO "ExtractorConfig" ("Key", "ValueJson", "ValueType", "UpdatedAt", "UpdatedBy", "Version")
                        VALUES ({keyLiteral}, {valueLiteral}::jsonb, {typeInt}, '{seedTimestamp}'::timestamptz, NULL, 0)
                        ON CONFLICT ("Key") DO NOTHING;
                        """);
                }
                else if (migrationBuilder.ActiveProvider == SqliteProvider)
                {
                    migrationBuilder.Sql($"""
                        INSERT OR IGNORE INTO ExtractorConfig (Key, ValueJson, ValueType, UpdatedAt, UpdatedBy, Version)
                        VALUES ({keyLiteral}, {valueLiteral}, {typeInt}, '{seedTimestamp}', NULL, 0);
                        """);
                }
            }
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ExtractorConfigHistory");

            migrationBuilder.DropTable(
                name: "ExtractorConfig");
        }

        /// <summary>
        /// Minimal SQL-literal escape for the seed strings. Every value
        /// here is a compile-time constant living in
        /// <see cref="ExtractorConfigDefaults"/>; escaping the single
        /// quotes is belt-and-suspenders so a future constant that does
        /// contain an apostrophe doesn't break the INSERT.
        /// </summary>
        private static string SqlString(string raw) =>
            "'" + raw.Replace("'", "''") + "'";
    }
}
