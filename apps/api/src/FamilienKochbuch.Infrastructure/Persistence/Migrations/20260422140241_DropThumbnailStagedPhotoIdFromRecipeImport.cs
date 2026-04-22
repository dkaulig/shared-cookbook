using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace FamilienKochbuch.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class DropThumbnailStagedPhotoIdFromRecipeImport : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // COVER-0 cleanup — backfill before drop. The pre-Slice-B
            // rows were saved with a non-null ThumbnailStagedPhotoId but
            // an empty CandidateStagedPhotoIds JSON array (the
            // downloader hadn't been rolled out yet). Promote the single
            // id into a one-element array so those imports still render
            // a cover tile on the picker grid after the column drops.
            //
            // Runs inside the migration's implicit transaction: either
            // the backfill AND the DropColumn commit together, or both
            // roll back on failure. No half-migrated state.
            migrationBuilder.Sql(
                @"UPDATE ""RecipeImports""
                  SET ""CandidateStagedPhotoIds"" = '[""' || ""ThumbnailStagedPhotoId"" || '""]'
                  WHERE ""ThumbnailStagedPhotoId"" IS NOT NULL
                    AND (""CandidateStagedPhotoIds"" IS NULL OR ""CandidateStagedPhotoIds"" = '[]');");

            migrationBuilder.DropColumn(
                name: "ThumbnailStagedPhotoId",
                table: "RecipeImports");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // COVER-0 cleanup — restore the column so a rollback can
            // re-run. Down migrations don't attempt the reverse backfill
            // (dropping the candidate array back to a single-id column
            // would lose the 2..6 non-default candidates); operators
            // hitting a rollback path must accept that detail loss.
            migrationBuilder.AddColumn<Guid>(
                name: "ThumbnailStagedPhotoId",
                table: "RecipeImports",
                type: "uuid",
                nullable: true);
        }
    }
}
