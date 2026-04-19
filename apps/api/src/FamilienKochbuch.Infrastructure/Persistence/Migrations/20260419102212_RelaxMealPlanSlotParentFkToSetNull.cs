using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace FamilienKochbuch.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class RelaxMealPlanSlotParentFkToSetNull : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_MealPlanSlots_MealPlanSlots_ParentSlotId",
                table: "MealPlanSlots");

            migrationBuilder.AddForeignKey(
                name: "FK_MealPlanSlots_MealPlanSlots_ParentSlotId",
                table: "MealPlanSlots",
                column: "ParentSlotId",
                principalTable: "MealPlanSlots",
                principalColumn: "Id",
                onDelete: ReferentialAction.SetNull);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_MealPlanSlots_MealPlanSlots_ParentSlotId",
                table: "MealPlanSlots");

            migrationBuilder.AddForeignKey(
                name: "FK_MealPlanSlots_MealPlanSlots_ParentSlotId",
                table: "MealPlanSlots",
                column: "ParentSlotId",
                principalTable: "MealPlanSlots",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);
        }
    }
}
