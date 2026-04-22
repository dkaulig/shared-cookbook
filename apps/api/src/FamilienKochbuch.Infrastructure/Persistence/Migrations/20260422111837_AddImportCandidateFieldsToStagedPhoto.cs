using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace FamilienKochbuch.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddImportCandidateFieldsToStagedPhoto : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "CandidateOrder",
                table: "StagedPhotos",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "LinkedImportId",
                table: "StagedPhotos",
                type: "uuid",
                nullable: true);

            // COVER-0 — JSON array of Guid staged-photo ids. Default
            // "[]" so existing pre-COVER-0 rows backfill to an empty
            // array when the EF reader deserialises them; the
            // ValueConverter would also tolerate "" but "[]" keeps the
            // DB representation honest for any non-EF reader.
            migrationBuilder.AddColumn<string>(
                name: "CandidateStagedPhotoIds",
                table: "RecipeImports",
                type: "text",
                nullable: false,
                defaultValue: "[]");

            migrationBuilder.CreateIndex(
                name: "IX_StagedPhotos_LinkedImportId",
                table: "StagedPhotos",
                column: "LinkedImportId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_StagedPhotos_LinkedImportId",
                table: "StagedPhotos");

            migrationBuilder.DropColumn(
                name: "CandidateOrder",
                table: "StagedPhotos");

            migrationBuilder.DropColumn(
                name: "LinkedImportId",
                table: "StagedPhotos");

            migrationBuilder.DropColumn(
                name: "CandidateStagedPhotoIds",
                table: "RecipeImports");
        }
    }
}
