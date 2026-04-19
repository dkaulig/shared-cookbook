using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.MealPlanning;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace FamilienKochbuch.Infrastructure.Persistence.Configurations;

/// <summary>
/// EF Core mapping for <see cref="MealPlanSlot"/> (P3-0). Enum stored as int
/// so future renames of <see cref="MealSlot"/> don't break the on-disk
/// contract. Composite index on (MealPlanId, Date, Meal, SortOrder) supports
/// the week-grid query the read endpoint fires (P3-1 / P3-2).
/// FK behaviours: MealPlan cascade (slots die with their plan), Recipe
/// SetNull (deleted recipe leaves the slot as a free-text Label — P3-4),
/// ParentSlot restrict (can't delete a parent while children reference it,
/// forces P3-1's DELETE handler to re-parent children first).
/// </summary>
internal sealed class MealPlanSlotConfiguration : IEntityTypeConfiguration<MealPlanSlot>
{
    public void Configure(EntityTypeBuilder<MealPlanSlot> e)
    {
        e.HasKey(s => s.Id);

        e.Property(s => s.MealPlanId).IsRequired();
        e.Property(s => s.Date).IsRequired();
        e.Property(s => s.Meal).HasConversion<int>().IsRequired();
        e.Property(s => s.Servings).IsRequired();
        e.Property(s => s.Label).HasMaxLength(MealPlanSlot.LabelMaxLength);
        e.Property(s => s.SortOrder).IsRequired();
        e.Property(s => s.IsCooked).IsRequired();
        e.Property(s => s.CreatedAt).IsRequired();
        e.Property(s => s.UpdatedAt).IsRequired();

        e.HasIndex(s => new { s.MealPlanId, s.Date, s.Meal, s.SortOrder })
            .HasDatabaseName("IX_MealPlanSlots_Plan_Date_Meal_SortOrder");

        // MealPlan FK is declared on the MealPlan side (HasMany/WithOne +
        // cascade) — keep the aggregate root as the single source of truth.

        e.HasOne<Recipe>()
            .WithMany()
            .HasForeignKey(s => s.RecipeId)
            // Recipe soft-deletes leave slots untouched. On hard-delete the
            // FK nulls out, and the slot survives as a freeform-Label entry.
            .OnDelete(DeleteBehavior.SetNull);

        e.HasOne(s => s.ParentSlot)
            .WithMany(s => s.Children)
            .HasForeignKey(s => s.ParentSlotId)
            // Restrict so the DELETE endpoint in P3-1 has to explicitly
            // re-parent or detach children before dropping the parent.
            .OnDelete(DeleteBehavior.Restrict);
    }
}
