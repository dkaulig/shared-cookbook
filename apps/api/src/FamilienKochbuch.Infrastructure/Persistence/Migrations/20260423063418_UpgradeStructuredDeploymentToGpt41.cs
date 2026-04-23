using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace FamilienKochbuch.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class UpgradeStructuredDeploymentToGpt41 : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // COMP-2 — bump structured-extraction defaults from
            // gpt-4.1-mini → gpt-4.1 (component-splitting robustness) +
            // pin temperature to 0 for determinism.
            //
            // Live production rows that were seeded pre-COMP-2 still carry
            // the mini + 0.5-temperature values. Update only where the old
            // defaults are still in place — admin tweaks via the extractor
            // UI are preserved untouched. Idempotent: the WHERE clause
            // misses on a second run.
            //
            // Postgres-only: uses ``::jsonb`` casts + ``NOW()``. SQLite
            // paths (the infrastructure test harness runs EF migrations
            // against an in-memory SQLite DB) don't have this schema —
            // the ExtractorConfig rows are seeded via DbContext
            // `HasData`, not via this migration — so skip on SQLite.
            if (migrationBuilder.ActiveProvider != "Npgsql.EntityFrameworkCore.PostgreSQL")
            {
                return;
            }

            migrationBuilder.Sql(
                @"UPDATE ""ExtractorConfig""
                  SET ""ValueJson"" = '""gpt-4.1""'::jsonb,
                      ""UpdatedAt"" = NOW(),
                      ""Version""   = ""Version"" + 1
                  WHERE ""Key"" = 'llm.structured.deployment'
                    AND ""ValueJson"" = '""gpt-4.1-mini""'::jsonb;");

            migrationBuilder.Sql(
                @"UPDATE ""ExtractorConfig""
                  SET ""ValueJson"" = '0'::jsonb,
                      ""UpdatedAt"" = NOW(),
                      ""Version""   = ""Version"" + 1
                  WHERE ""Key"" = 'llm.structured.temperature'
                    AND ""ValueJson"" = '0.5'::jsonb;");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // Reverse — revert only rows that match the COMP-2 values we
            // just set. Postgres-only, for the same reason as Up().
            if (migrationBuilder.ActiveProvider != "Npgsql.EntityFrameworkCore.PostgreSQL")
            {
                return;
            }

            migrationBuilder.Sql(
                @"UPDATE ""ExtractorConfig""
                  SET ""ValueJson"" = '""gpt-4.1-mini""'::jsonb,
                      ""UpdatedAt"" = NOW(),
                      ""Version""   = ""Version"" + 1
                  WHERE ""Key"" = 'llm.structured.deployment'
                    AND ""ValueJson"" = '""gpt-4.1""'::jsonb;");

            migrationBuilder.Sql(
                @"UPDATE ""ExtractorConfig""
                  SET ""ValueJson"" = '0.5'::jsonb,
                      ""UpdatedAt"" = NOW(),
                      ""Version""   = ""Version"" + 1
                  WHERE ""Key"" = 'llm.structured.temperature'
                    AND ""ValueJson"" = '0'::jsonb;");
        }
    }
}
