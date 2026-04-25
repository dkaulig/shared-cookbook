using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace SharedCookbook.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddRecipeImportPhaseProgress : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "AttemptNumber",
                table: "RecipeImports",
                type: "integer",
                nullable: false,
                defaultValue: 1);

            migrationBuilder.AddColumn<long>(
                name: "BytesDownloaded",
                table: "RecipeImports",
                type: "bigint",
                nullable: true);

            migrationBuilder.AddColumn<long>(
                name: "BytesTotal",
                table: "RecipeImports",
                type: "bigint",
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "LastProgressAt",
                table: "RecipeImports",
                type: "timestamp with time zone",
                nullable: false,
                defaultValueSql: "CURRENT_TIMESTAMP");

            migrationBuilder.AddColumn<int>(
                name: "Phase",
                table: "RecipeImports",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<int>(
                name: "PhaseProgress",
                table: "RecipeImports",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<string>(
                name: "ProgressLabel",
                table: "RecipeImports",
                type: "character varying(200)",
                maxLength: 200,
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "SegmentsDone",
                table: "RecipeImports",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "SegmentsTotal",
                table: "RecipeImports",
                type: "integer",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "AttemptNumber",
                table: "RecipeImports");

            migrationBuilder.DropColumn(
                name: "BytesDownloaded",
                table: "RecipeImports");

            migrationBuilder.DropColumn(
                name: "BytesTotal",
                table: "RecipeImports");

            migrationBuilder.DropColumn(
                name: "LastProgressAt",
                table: "RecipeImports");

            migrationBuilder.DropColumn(
                name: "Phase",
                table: "RecipeImports");

            migrationBuilder.DropColumn(
                name: "PhaseProgress",
                table: "RecipeImports");

            migrationBuilder.DropColumn(
                name: "ProgressLabel",
                table: "RecipeImports");

            migrationBuilder.DropColumn(
                name: "SegmentsDone",
                table: "RecipeImports");

            migrationBuilder.DropColumn(
                name: "SegmentsTotal",
                table: "RecipeImports");
        }
    }
}
