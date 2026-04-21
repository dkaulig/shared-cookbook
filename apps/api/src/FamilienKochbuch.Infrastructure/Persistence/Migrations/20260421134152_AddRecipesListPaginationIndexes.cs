using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace FamilienKochbuch.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// PAGE-0 — composite partial indexes matching each sort key of the
    /// paginated <c>GET /api/groups/{groupId}/recipes</c> endpoint
    /// (see <c>docs/plans/2026-04-21-recipe-list-pagination-design.md</c>).
    /// Each index is partial on <c>"DeletedAt" IS NULL</c> so the
    /// soft-delete filter + sort can share a single index scan, and each
    /// carries <c>Id</c> as the trailing tie-breaker column to keep the
    /// order stable across identical leading keys.
    ///
    /// <para>
    /// Postgres-only. The SQLite-backed integration tests don't rely on
    /// these indexes for correctness (the endpoint sorts materialised
    /// rows in memory on SQLite — same pattern as
    /// <c>PostgresRecipeSearchService</c>). Deferring would leak the
    /// "perf-only" indexes into the test schema unnecessarily, and
    /// SQLite's partial-index syntax differs enough that a portable
    /// definition would be a net loss.
    /// </para>
    ///
    /// <para>
    /// <c>cook_count_desc</c> and its index are cut from PAGE-0 — the
    /// <c>Recipe</c> entity has no <c>TimesCooked</c> column and there's
    /// no <c>CookHistory</c> aggregation table. Revisit when one exists.
    /// </para>
    /// </summary>
    public partial class AddRecipesListPaginationIndexes : Migration
    {
        private const string NpgsqlProvider = "Npgsql.EntityFrameworkCore.PostgreSQL";

        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            if (migrationBuilder.ActiveProvider != NpgsqlProvider) return;

            migrationBuilder.Sql(
                """
                CREATE INDEX IF NOT EXISTS "ix_recipes_group_updated"
                    ON "Recipes" ("GroupId", "UpdatedAt" DESC, "Id")
                    WHERE "DeletedAt" IS NULL;
                """);

            migrationBuilder.Sql(
                """
                CREATE INDEX IF NOT EXISTS "ix_recipes_group_title"
                    ON "Recipes" ("GroupId", "Title", "Id")
                    WHERE "DeletedAt" IS NULL;
                """);

            migrationBuilder.Sql(
                """
                CREATE INDEX IF NOT EXISTS "ix_recipes_group_cooked"
                    ON "Recipes" ("GroupId", "LastCookedAt" DESC NULLS LAST, "Id")
                    WHERE "DeletedAt" IS NULL;
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            if (migrationBuilder.ActiveProvider != NpgsqlProvider) return;

            migrationBuilder.Sql("DROP INDEX IF EXISTS \"ix_recipes_group_cooked\";");
            migrationBuilder.Sql("DROP INDEX IF EXISTS \"ix_recipes_group_title\";");
            migrationBuilder.Sql("DROP INDEX IF EXISTS \"ix_recipes_group_updated\";");
        }
    }
}
