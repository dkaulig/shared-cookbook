using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace FamilienKochbuch.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// COMP-0 — introduce the <c>RecipeComponents</c> table plus a
    /// <c>ComponentId</c> column on <c>Ingredients</c> and
    /// <c>RecipeSteps</c>. See
    /// <c>docs/plans/2026-04-21-recipe-components-design.md</c>.
    ///
    /// <para>
    /// Backfill strategy (all inside one transaction, idempotent):
    /// <list type="number">
    /// <item>Add the <c>ComponentId</c> columns as <b>nullable</b> so the
    /// existing rows stay valid.</item>
    /// <item>Create the <c>RecipeComponents</c> table + FK to Recipes.</item>
    /// <item>INSERT one default component per existing recipe with
    /// <c>label = NULL</c>, <c>position = 0</c>.</item>
    /// <item>UPDATE every Ingredient / RecipeStep row so its
    /// <c>ComponentId</c> points at the corresponding recipe's default
    /// component.</item>
    /// <item>ALTER the <c>ComponentId</c> columns to NOT NULL.</item>
    /// <item>Drop the pre-COMP-0 <c>(RecipeId, Position)</c> unique
    /// indexes and replace them with <c>(ComponentId, Position)</c> —
    /// position uniqueness is scoped to the component now so two
    /// components can each carry their own 0-based ingredient / step
    /// list.</item>
    /// <item>Add the FK from Ingredients + RecipeSteps to
    /// RecipeComponents.</item>
    /// </list>
    /// </para>
    ///
    /// <para>
    /// Postgres + SQLite need slightly different SQL for (a) UUID
    /// generation and (b) ALTER COLUMN ... SET NOT NULL. Provider-
    /// specific branches below keep the integration-test harness
    /// (<see cref="SeededTagsTests"/> +
    /// <see cref="AddRecipeComponentsMigrationTests"/>) working against
    /// SQLite while Postgres still gets the production path.
    /// </para>
    /// </summary>
    public partial class AddRecipeComponents : Migration
    {
        private const string NpgsqlProvider = "Npgsql.EntityFrameworkCore.PostgreSQL";
        private const string SqliteProvider = "Microsoft.EntityFrameworkCore.Sqlite";

        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // 1) ComponentId columns — added as NULLABLE so existing rows
            //    survive until the backfill populates them.
            migrationBuilder.AddColumn<Guid>(
                name: "ComponentId",
                table: "RecipeSteps",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "ComponentId",
                table: "Ingredients",
                type: "uuid",
                nullable: true);

            // 2) RecipeComponents table + cascade FK.
            migrationBuilder.CreateTable(
                name: "RecipeComponents",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    RecipeId = table.Column<Guid>(type: "uuid", nullable: false),
                    Position = table.Column<int>(type: "integer", nullable: false),
                    Label = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_RecipeComponents", x => x.Id);
                    table.ForeignKey(
                        name: "FK_RecipeComponents_Recipes_RecipeId",
                        column: x => x.RecipeId,
                        principalTable: "Recipes",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_RecipeComponents_RecipeId",
                table: "RecipeComponents",
                column: "RecipeId");

            migrationBuilder.CreateIndex(
                name: "IX_RecipeComponents_RecipeId_Position",
                table: "RecipeComponents",
                columns: new[] { "RecipeId", "Position" },
                unique: true);

            // 3) Backfill — one default component per recipe + hook up
            //    every existing ingredient + step to that component.
            if (migrationBuilder.ActiveProvider == NpgsqlProvider)
            {
                migrationBuilder.Sql(
                    """CREATE EXTENSION IF NOT EXISTS "pgcrypto";""");

                migrationBuilder.Sql(
                    """
                    INSERT INTO "RecipeComponents" ("Id", "RecipeId", "Position", "Label")
                    SELECT gen_random_uuid(), r."Id", 0, NULL
                    FROM "Recipes" r
                    WHERE NOT EXISTS (
                        SELECT 1 FROM "RecipeComponents" rc WHERE rc."RecipeId" = r."Id"
                    );
                    """);

                migrationBuilder.Sql(
                    """
                    UPDATE "Ingredients" i
                    SET "ComponentId" = (
                        SELECT rc."Id"
                        FROM "RecipeComponents" rc
                        WHERE rc."RecipeId" = i."RecipeId" AND rc."Position" = 0
                        LIMIT 1
                    )
                    WHERE i."ComponentId" IS NULL;
                    """);

                migrationBuilder.Sql(
                    """
                    UPDATE "RecipeSteps" s
                    SET "ComponentId" = (
                        SELECT rc."Id"
                        FROM "RecipeComponents" rc
                        WHERE rc."RecipeId" = s."RecipeId" AND rc."Position" = 0
                        LIMIT 1
                    )
                    WHERE s."ComponentId" IS NULL;
                    """);
            }
            else if (migrationBuilder.ActiveProvider == SqliteProvider)
            {
                migrationBuilder.Sql(
                    """
                    INSERT INTO RecipeComponents (Id, RecipeId, Position, Label)
                    SELECT
                        lower(hex(randomblob(4)))
                        || '-' || lower(hex(randomblob(2)))
                        || '-' || lower(hex(randomblob(2)))
                        || '-' || lower(hex(randomblob(2)))
                        || '-' || lower(hex(randomblob(6))),
                        r.Id, 0, NULL
                    FROM Recipes r
                    WHERE NOT EXISTS (
                        SELECT 1 FROM RecipeComponents rc WHERE rc.RecipeId = r.Id
                    );
                    """);

                migrationBuilder.Sql(
                    """
                    UPDATE Ingredients
                    SET ComponentId = (
                        SELECT rc.Id FROM RecipeComponents rc
                        WHERE rc.RecipeId = Ingredients.RecipeId AND rc.Position = 0
                        LIMIT 1
                    )
                    WHERE ComponentId IS NULL;
                    """);

                migrationBuilder.Sql(
                    """
                    UPDATE RecipeSteps
                    SET ComponentId = (
                        SELECT rc.Id FROM RecipeComponents rc
                        WHERE rc.RecipeId = RecipeSteps.RecipeId AND rc.Position = 0
                        LIMIT 1
                    )
                    WHERE ComponentId IS NULL;
                    """);
            }

            // 4) ALTER the ComponentId columns to NOT NULL now that every
            //    row has been filled.
            if (migrationBuilder.ActiveProvider == NpgsqlProvider)
            {
                migrationBuilder.Sql(
                    """ALTER TABLE "Ingredients" ALTER COLUMN "ComponentId" SET NOT NULL;""");
                migrationBuilder.Sql(
                    """ALTER TABLE "RecipeSteps" ALTER COLUMN "ComponentId" SET NOT NULL;""");
            }
            else if (migrationBuilder.ActiveProvider == SqliteProvider)
            {
                migrationBuilder.AlterColumn<Guid>(
                    name: "ComponentId",
                    table: "Ingredients",
                    type: "uuid",
                    nullable: false,
                    oldClrType: typeof(Guid),
                    oldType: "uuid",
                    oldNullable: true);
                migrationBuilder.AlterColumn<Guid>(
                    name: "ComponentId",
                    table: "RecipeSteps",
                    type: "uuid",
                    nullable: false,
                    oldClrType: typeof(Guid),
                    oldType: "uuid",
                    oldNullable: true);
            }

            // 5) Flip the pre-COMP-0 (RecipeId, Position) unique indexes
            //    to (ComponentId, Position). Components now own position
            //    uniqueness: two components in the same recipe can each
            //    carry their own 0-based ingredient + step list.
            migrationBuilder.DropIndex(
                name: "IX_Ingredients_RecipeId_Position",
                table: "Ingredients");

            migrationBuilder.DropIndex(
                name: "IX_RecipeSteps_RecipeId_Position",
                table: "RecipeSteps");

            migrationBuilder.CreateIndex(
                name: "IX_Ingredients_ComponentId_Position",
                table: "Ingredients",
                columns: new[] { "ComponentId", "Position" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_RecipeSteps_ComponentId_Position",
                table: "RecipeSteps",
                columns: new[] { "ComponentId", "Position" },
                unique: true);

            // 6) FK from the child rows to their owning component.
            migrationBuilder.AddForeignKey(
                name: "FK_Ingredients_RecipeComponents_ComponentId",
                table: "Ingredients",
                column: "ComponentId",
                principalTable: "RecipeComponents",
                principalColumn: "Id",
                onDelete: ReferentialAction.Cascade);

            migrationBuilder.AddForeignKey(
                name: "FK_RecipeSteps_RecipeComponents_ComponentId",
                table: "RecipeSteps",
                column: "ComponentId",
                principalTable: "RecipeComponents",
                principalColumn: "Id",
                onDelete: ReferentialAction.Cascade);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_Ingredients_RecipeComponents_ComponentId",
                table: "Ingredients");

            migrationBuilder.DropForeignKey(
                name: "FK_RecipeSteps_RecipeComponents_ComponentId",
                table: "RecipeSteps");

            migrationBuilder.DropIndex(
                name: "IX_Ingredients_ComponentId_Position",
                table: "Ingredients");

            migrationBuilder.DropIndex(
                name: "IX_RecipeSteps_ComponentId_Position",
                table: "RecipeSteps");

            migrationBuilder.CreateIndex(
                name: "IX_Ingredients_RecipeId_Position",
                table: "Ingredients",
                columns: new[] { "RecipeId", "Position" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_RecipeSteps_RecipeId_Position",
                table: "RecipeSteps",
                columns: new[] { "RecipeId", "Position" },
                unique: true);

            migrationBuilder.DropTable(
                name: "RecipeComponents");

            migrationBuilder.DropColumn(
                name: "ComponentId",
                table: "RecipeSteps");

            migrationBuilder.DropColumn(
                name: "ComponentId",
                table: "Ingredients");
        }
    }
}
