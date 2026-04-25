using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace SharedCookbook.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddTokenUsageTracking : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "CachedPromptTokens",
                table: "RecipeImports",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "CompletionTokens",
                table: "RecipeImports",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "ModelDeployment",
                table: "RecipeImports",
                type: "character varying(200)",
                maxLength: 200,
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "PromptTokens",
                table: "RecipeImports",
                type: "integer",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "ChatUsageLogs",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    SessionId = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    Kind = table.Column<int>(type: "integer", nullable: false),
                    PromptTokens = table.Column<int>(type: "integer", nullable: false),
                    CompletionTokens = table.Column<int>(type: "integer", nullable: false),
                    CachedPromptTokens = table.Column<int>(type: "integer", nullable: false),
                    ModelDeployment = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ChatUsageLogs", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ChatUsageLogs_AspNetUsers_UserId",
                        column: x => x.UserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "IX_ChatUsageLogs_ModelDeployment_CreatedAt",
                table: "ChatUsageLogs",
                columns: new[] { "ModelDeployment", "CreatedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_ChatUsageLogs_UserId_CreatedAt",
                table: "ChatUsageLogs",
                columns: new[] { "UserId", "CreatedAt" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ChatUsageLogs");

            migrationBuilder.DropColumn(
                name: "CachedPromptTokens",
                table: "RecipeImports");

            migrationBuilder.DropColumn(
                name: "CompletionTokens",
                table: "RecipeImports");

            migrationBuilder.DropColumn(
                name: "ModelDeployment",
                table: "RecipeImports");

            migrationBuilder.DropColumn(
                name: "PromptTokens",
                table: "RecipeImports");
        }
    }
}
