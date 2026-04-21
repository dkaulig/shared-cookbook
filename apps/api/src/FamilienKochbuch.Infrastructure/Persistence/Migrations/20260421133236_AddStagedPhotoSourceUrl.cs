using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace FamilienKochbuch.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddStagedPhotoSourceUrl : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "SourceUrl",
                table: "StagedPhotos",
                type: "character varying(2000)",
                maxLength: 2000,
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_StagedPhotos_PromotedToRecipeId_SourceUrl",
                table: "StagedPhotos",
                columns: new[] { "PromotedToRecipeId", "SourceUrl" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_StagedPhotos_PromotedToRecipeId_SourceUrl",
                table: "StagedPhotos");

            migrationBuilder.DropColumn(
                name: "SourceUrl",
                table: "StagedPhotos");
        }
    }
}
