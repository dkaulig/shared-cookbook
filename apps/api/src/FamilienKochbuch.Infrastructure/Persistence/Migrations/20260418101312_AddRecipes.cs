using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace FamilienKochbuch.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddRecipes : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "Recipes",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    GroupId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedByUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Title = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    Description = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true),
                    DefaultServings = table.Column<int>(type: "integer", nullable: false),
                    PrepTimeMinutes = table.Column<int>(type: "integer", nullable: true),
                    Difficulty = table.Column<int>(type: "integer", nullable: false),
                    SourceUrl = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true),
                    SourceType = table.Column<int>(type: "integer", nullable: false),
                    ForkOfRecipeId = table.Column<Guid>(type: "uuid", nullable: true),
                    Photos = table.Column<string>(type: "text", nullable: false),
                    LastCookedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    DeletedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Recipes", x => x.Id);
                    table.ForeignKey(
                        name: "FK_Recipes_AspNetUsers_CreatedByUserId",
                        column: x => x.CreatedByUserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_Recipes_Groups_GroupId",
                        column: x => x.GroupId,
                        principalTable: "Groups",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "Tags",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Name = table.Column<string>(type: "character varying(60)", maxLength: 60, nullable: false),
                    Category = table.Column<int>(type: "integer", nullable: false),
                    CreatedByUserId = table.Column<Guid>(type: "uuid", nullable: true),
                    GroupId = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Tags", x => x.Id);
                    table.ForeignKey(
                        name: "FK_Tags_AspNetUsers_CreatedByUserId",
                        column: x => x.CreatedByUserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_Tags_Groups_GroupId",
                        column: x => x.GroupId,
                        principalTable: "Groups",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "Ingredients",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    RecipeId = table.Column<Guid>(type: "uuid", nullable: false),
                    Position = table.Column<int>(type: "integer", nullable: false),
                    Quantity = table.Column<decimal>(type: "numeric(12,3)", nullable: true),
                    Unit = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: false),
                    Name = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    Note = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    Scalable = table.Column<bool>(type: "boolean", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Ingredients", x => x.Id);
                    table.ForeignKey(
                        name: "FK_Ingredients_Recipes_RecipeId",
                        column: x => x.RecipeId,
                        principalTable: "Recipes",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "RecipeSteps",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    RecipeId = table.Column<Guid>(type: "uuid", nullable: false),
                    Position = table.Column<int>(type: "integer", nullable: false),
                    Content = table.Column<string>(type: "character varying(5000)", maxLength: 5000, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_RecipeSteps", x => x.Id);
                    table.ForeignKey(
                        name: "FK_RecipeSteps_Recipes_RecipeId",
                        column: x => x.RecipeId,
                        principalTable: "Recipes",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "RecipeTags",
                columns: table => new
                {
                    RecipeId = table.Column<Guid>(type: "uuid", nullable: false),
                    TagId = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_RecipeTags", x => new { x.RecipeId, x.TagId });
                    table.ForeignKey(
                        name: "FK_RecipeTags_Recipes_RecipeId",
                        column: x => x.RecipeId,
                        principalTable: "Recipes",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_RecipeTags_Tags_TagId",
                        column: x => x.TagId,
                        principalTable: "Tags",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_Ingredients_RecipeId",
                table: "Ingredients",
                column: "RecipeId");

            migrationBuilder.CreateIndex(
                name: "IX_Ingredients_RecipeId_Position",
                table: "Ingredients",
                columns: new[] { "RecipeId", "Position" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Recipes_CreatedAt",
                table: "Recipes",
                column: "CreatedAt");

            migrationBuilder.CreateIndex(
                name: "IX_Recipes_CreatedByUserId",
                table: "Recipes",
                column: "CreatedByUserId");

            migrationBuilder.CreateIndex(
                name: "IX_Recipes_DeletedAt",
                table: "Recipes",
                column: "DeletedAt");

            migrationBuilder.CreateIndex(
                name: "IX_Recipes_GroupId",
                table: "Recipes",
                column: "GroupId");

            migrationBuilder.CreateIndex(
                name: "IX_RecipeSteps_RecipeId",
                table: "RecipeSteps",
                column: "RecipeId");

            migrationBuilder.CreateIndex(
                name: "IX_RecipeSteps_RecipeId_Position",
                table: "RecipeSteps",
                columns: new[] { "RecipeId", "Position" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_RecipeTags_TagId",
                table: "RecipeTags",
                column: "TagId");

            migrationBuilder.CreateIndex(
                name: "IX_Tags_CreatedByUserId",
                table: "Tags",
                column: "CreatedByUserId");

            migrationBuilder.CreateIndex(
                name: "IX_Tags_GroupId",
                table: "Tags",
                column: "GroupId");

            migrationBuilder.CreateIndex(
                name: "IX_Tags_Name_Category_GroupId",
                table: "Tags",
                columns: new[] { "Name", "Category", "GroupId" },
                unique: true);

            SeedGlobalTags(migrationBuilder);
        }

        /// <summary>
        /// Seeds the 30 predefined global tags (PRD §4.2). All ids are stable
        /// GUIDs so re-running the migration on an empty DB and inspecting
        /// it twice shows identical rows — safe to rebuild test DBs from
        /// migrations without drift.
        ///
        /// Categories encoded as their enum ordinal:
        ///   0 = Mahlzeit, 1 = Saison, 2 = Typ, 3 = Aufwand,
        ///   4 = Diaet,    5 = Kueche
        /// Custom (6) is not seeded — those are created at runtime.
        /// </summary>
        private static void SeedGlobalTags(MigrationBuilder migrationBuilder)
        {
            var columns = new[] { "Id", "Name", "Category", "CreatedByUserId", "GroupId" };

            object[,] rows =
            {
                // Mahlzeit
                { new Guid("a0000001-0000-0000-0000-000000000001"), "Frühstück", 0, null!, null! },
                { new Guid("a0000001-0000-0000-0000-000000000002"), "Mittag",    0, null!, null! },
                { new Guid("a0000001-0000-0000-0000-000000000003"), "Abend",     0, null!, null! },
                { new Guid("a0000001-0000-0000-0000-000000000004"), "Snack",     0, null!, null! },
                { new Guid("a0000001-0000-0000-0000-000000000005"), "Dessert",   0, null!, null! },

                // Saison
                { new Guid("a0000002-0000-0000-0000-000000000001"), "Frühling",   1, null!, null! },
                { new Guid("a0000002-0000-0000-0000-000000000002"), "Sommer",     1, null!, null! },
                { new Guid("a0000002-0000-0000-0000-000000000003"), "Herbst",     1, null!, null! },
                { new Guid("a0000002-0000-0000-0000-000000000004"), "Winter",     1, null!, null! },
                { new Guid("a0000002-0000-0000-0000-000000000005"), "ganzjährig", 1, null!, null! },

                // Typ
                { new Guid("a0000003-0000-0000-0000-000000000001"), "warm",   2, null!, null! },
                { new Guid("a0000003-0000-0000-0000-000000000002"), "kalt",   2, null!, null! },
                { new Guid("a0000003-0000-0000-0000-000000000003"), "deftig", 2, null!, null! },
                { new Guid("a0000003-0000-0000-0000-000000000004"), "süß",    2, null!, null! },
                { new Guid("a0000003-0000-0000-0000-000000000005"), "leicht", 2, null!, null! },

                // Aufwand
                { new Guid("a0000004-0000-0000-0000-000000000001"), "schnell",    3, null!, null! },
                { new Guid("a0000004-0000-0000-0000-000000000002"), "mittel",     3, null!, null! },
                { new Guid("a0000004-0000-0000-0000-000000000003"), "aufwendig",  3, null!, null! },

                // Diaet
                { new Guid("a0000005-0000-0000-0000-000000000001"), "vegetarisch", 4, null!, null! },
                { new Guid("a0000005-0000-0000-0000-000000000002"), "vegan",       4, null!, null! },
                { new Guid("a0000005-0000-0000-0000-000000000003"), "glutenfrei",  4, null!, null! },
                { new Guid("a0000005-0000-0000-0000-000000000004"), "laktosefrei", 4, null!, null! },

                // Kueche
                { new Guid("a0000006-0000-0000-0000-000000000001"), "deutsch",      5, null!, null! },
                { new Guid("a0000006-0000-0000-0000-000000000002"), "italienisch",  5, null!, null! },
                { new Guid("a0000006-0000-0000-0000-000000000003"), "asiatisch",    5, null!, null! },
                { new Guid("a0000006-0000-0000-0000-000000000004"), "mexikanisch",  5, null!, null! },
                { new Guid("a0000006-0000-0000-0000-000000000005"), "französisch",  5, null!, null! },
                { new Guid("a0000006-0000-0000-0000-000000000006"), "spanisch",     5, null!, null! },
                { new Guid("a0000006-0000-0000-0000-000000000007"), "indisch",      5, null!, null! },
                { new Guid("a0000006-0000-0000-0000-000000000008"), "orientalisch", 5, null!, null! },
            };

            migrationBuilder.InsertData(
                table: "Tags",
                columns: columns,
                values: rows);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "Ingredients");

            migrationBuilder.DropTable(
                name: "RecipeSteps");

            migrationBuilder.DropTable(
                name: "RecipeTags");

            migrationBuilder.DropTable(
                name: "Recipes");

            migrationBuilder.DropTable(
                name: "Tags");
        }
    }
}
