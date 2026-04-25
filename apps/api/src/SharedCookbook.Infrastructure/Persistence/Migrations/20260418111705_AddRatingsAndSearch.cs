using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace SharedCookbook.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddRatingsAndSearch : Migration
    {
        private const string NpgsqlProvider = "Npgsql.EntityFrameworkCore.PostgreSQL";

        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "Ratings",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    RecipeId = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Stars = table.Column<int>(type: "integer", nullable: false),
                    Comment = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Ratings", x => x.Id);
                    table.ForeignKey(
                        name: "FK_Ratings_AspNetUsers_UserId",
                        column: x => x.UserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_Ratings_Recipes_RecipeId",
                        column: x => x.RecipeId,
                        principalTable: "Recipes",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_Ratings_RecipeId",
                table: "Ratings",
                column: "RecipeId");

            migrationBuilder.CreateIndex(
                name: "IX_Ratings_RecipeId_UserId",
                table: "Ratings",
                columns: new[] { "RecipeId", "UserId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Ratings_UserId",
                table: "Ratings",
                column: "UserId");

            // ── Postgres-only: tsvector + trigger-maintained search column ──
            //
            // EF Core cannot easily generate a cross-table `GENERATED ALWAYS
            // AS` tsvector (Title + Description pull from the Recipe row; the
            // ingredient names come from the child Ingredients table). So we
            // keep `Recipes.SearchVector` in sync via two triggers:
            //
            //   1. BEFORE INSERT/UPDATE on Recipes (Title/Description): sets
            //      SearchVector on the NEW row.
            //   2. AFTER INSERT/UPDATE/DELETE on Ingredients: re-runs the
            //      update against the parent Recipe.
            //
            // Configuration is `'german'` for proper umlaut folding + stop
            // words. A GIN index on the column gives websearch_to_tsquery
            // sub-millisecond lookups for the hobby-scale corpus.
            //
            // SQLite-backed integration tests skip this block (no tsvector
            // type, no GIN index), and `PostgresRecipeSearchService` falls
            // back to a LIKE-based search path when the active provider is
            // SQLite.
            if (migrationBuilder.ActiveProvider == NpgsqlProvider)
            {
                migrationBuilder.Sql(
                    "ALTER TABLE \"Recipes\" ADD COLUMN \"SearchVector\" tsvector;");

                migrationBuilder.Sql(
                    """
                    CREATE OR REPLACE FUNCTION fkochbuch_update_recipe_search_vector(target_id uuid)
                    RETURNS void AS $$
                    BEGIN
                        UPDATE "Recipes"
                        SET "SearchVector" =
                            setweight(to_tsvector('german', coalesce("Title", '')), 'A') ||
                            setweight(to_tsvector('german', coalesce("Description", '')), 'B') ||
                            setweight(to_tsvector('german', coalesce((
                                SELECT string_agg("Name", ' ')
                                FROM "Ingredients"
                                WHERE "Ingredients"."RecipeId" = target_id
                            ), '')), 'C')
                        WHERE "Id" = target_id;
                    END;
                    $$ LANGUAGE plpgsql;
                    """);

                migrationBuilder.Sql(
                    """
                    CREATE OR REPLACE FUNCTION fkochbuch_recipe_search_vector_trigger()
                    RETURNS trigger AS $$
                    BEGIN
                        PERFORM fkochbuch_update_recipe_search_vector(NEW."Id");
                        RETURN NEW;
                    END;
                    $$ LANGUAGE plpgsql;
                    """);

                migrationBuilder.Sql(
                    """
                    CREATE OR REPLACE FUNCTION fkochbuch_ingredient_search_vector_trigger()
                    RETURNS trigger AS $$
                    DECLARE
                        target_id uuid;
                    BEGIN
                        IF (TG_OP = 'DELETE') THEN
                            target_id := OLD."RecipeId";
                        ELSE
                            target_id := NEW."RecipeId";
                        END IF;
                        PERFORM fkochbuch_update_recipe_search_vector(target_id);
                        IF (TG_OP = 'DELETE') THEN
                            RETURN OLD;
                        END IF;
                        RETURN NEW;
                    END;
                    $$ LANGUAGE plpgsql;
                    """);

                // Fires AFTER commit to avoid PERFORM re-entering the same row
                // during the INSERT of the Recipe itself; the AFTER-trigger on
                // Recipes rewrites the row post-insert.
                migrationBuilder.Sql(
                    """
                    CREATE TRIGGER trg_recipes_search_vector
                    AFTER INSERT OR UPDATE OF "Title", "Description"
                    ON "Recipes"
                    FOR EACH ROW
                    EXECUTE FUNCTION fkochbuch_recipe_search_vector_trigger();
                    """);

                migrationBuilder.Sql(
                    """
                    CREATE TRIGGER trg_ingredients_search_vector
                    AFTER INSERT OR UPDATE OR DELETE
                    ON "Ingredients"
                    FOR EACH ROW
                    EXECUTE FUNCTION fkochbuch_ingredient_search_vector_trigger();
                    """);

                // One-time backfill for any rows that pre-date this migration.
                migrationBuilder.Sql(
                    """
                    DO $$
                    DECLARE r_id uuid;
                    BEGIN
                        FOR r_id IN SELECT "Id" FROM "Recipes" LOOP
                            PERFORM fkochbuch_update_recipe_search_vector(r_id);
                        END LOOP;
                    END $$;
                    """);

                migrationBuilder.Sql(
                    "CREATE INDEX \"IX_Recipes_SearchVector\" ON \"Recipes\" USING GIN (\"SearchVector\");");
            }
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            if (migrationBuilder.ActiveProvider == NpgsqlProvider)
            {
                migrationBuilder.Sql("DROP INDEX IF EXISTS \"IX_Recipes_SearchVector\";");
                migrationBuilder.Sql("DROP TRIGGER IF EXISTS trg_ingredients_search_vector ON \"Ingredients\";");
                migrationBuilder.Sql("DROP TRIGGER IF EXISTS trg_recipes_search_vector ON \"Recipes\";");
                migrationBuilder.Sql("DROP FUNCTION IF EXISTS fkochbuch_ingredient_search_vector_trigger();");
                migrationBuilder.Sql("DROP FUNCTION IF EXISTS fkochbuch_recipe_search_vector_trigger();");
                migrationBuilder.Sql("DROP FUNCTION IF EXISTS fkochbuch_update_recipe_search_vector(uuid);");
                migrationBuilder.Sql("ALTER TABLE \"Recipes\" DROP COLUMN IF EXISTS \"SearchVector\";");
            }

            migrationBuilder.DropTable(
                name: "Ratings");
        }
    }
}
