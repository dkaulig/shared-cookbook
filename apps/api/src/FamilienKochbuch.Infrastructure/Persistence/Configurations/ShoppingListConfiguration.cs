using FamilienKochbuch.Domain.MealPlanning;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace FamilienKochbuch.Infrastructure.Persistence.Configurations;

/// <summary>
/// EF Core mapping for the <see cref="ShoppingList"/> aggregate (P3-5).
/// Strict 1:1 with <see cref="MealPlan"/>: unique index on
/// <see cref="ShoppingList.MealPlanId"/> + cascade delete so a plan
/// deletion reaps its shopping list + all items in a single tx.
/// </summary>
internal sealed class ShoppingListConfiguration : IEntityTypeConfiguration<ShoppingList>
{
    public void Configure(EntityTypeBuilder<ShoppingList> e)
    {
        e.HasKey(l => l.Id);

        e.Property(l => l.MealPlanId).IsRequired();
        e.Property(l => l.CreatedAt).IsRequired();
        e.Property(l => l.UpdatedAt).IsRequired();
        e.Property(l => l.LastGeneratedAt).IsRequired();

        // One shopping list per meal plan. The endpoint-layer create path
        // is idempotent — if a list already exists it's reused rather
        // than colliding on insert.
        e.HasIndex(l => l.MealPlanId)
            .IsUnique()
            .HasDatabaseName("IX_ShoppingLists_MealPlanId_Unique");

        // Plan is the owner: delete cascades through list → items.
        e.HasOne<MealPlan>()
            .WithMany()
            .HasForeignKey(l => l.MealPlanId)
            .OnDelete(DeleteBehavior.Cascade);

        e.HasMany(l => l.Items)
            .WithOne()
            .HasForeignKey(i => i.ShoppingListId)
            .OnDelete(DeleteBehavior.Cascade);
    }
}
