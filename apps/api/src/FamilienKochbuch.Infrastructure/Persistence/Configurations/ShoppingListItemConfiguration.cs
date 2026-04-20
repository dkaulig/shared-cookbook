using FamilienKochbuch.Domain.MealPlanning;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace FamilienKochbuch.Infrastructure.Persistence.Configurations;

/// <summary>
/// EF Core mapping for <see cref="ShoppingListItem"/> (P3-5). Category
/// + Source are stored as int so future enum renames don't break the
/// on-disk contract. Composite index on
/// (<see cref="ShoppingListItem.ShoppingListId"/>,
/// <see cref="ShoppingListItem.Category"/>,
/// <see cref="ShoppingListItem.SortOrder"/>) backs the "grouped by
/// category, sorted within" shopping-list UI query (P3-7).
/// The parent-list FK + cascade is declared on the
/// <see cref="ShoppingListConfiguration"/> side so the aggregate root
/// stays the single source of truth.
/// </summary>
internal sealed class ShoppingListItemConfiguration : IEntityTypeConfiguration<ShoppingListItem>
{
    public void Configure(EntityTypeBuilder<ShoppingListItem> e)
    {
        e.HasKey(i => i.Id);

        e.Property(i => i.ShoppingListId).IsRequired();
        e.Property(i => i.Name).IsRequired().HasMaxLength(ShoppingListItem.NameMaxLength);
        e.Property(i => i.Quantity).HasMaxLength(ShoppingListItem.QuantityMaxLength);
        e.Property(i => i.Unit).HasMaxLength(ShoppingListItem.UnitMaxLength);
        e.Property(i => i.Note).HasMaxLength(ShoppingListItem.NoteMaxLength);
        e.Property(i => i.IsChecked).IsRequired();
        e.Property(i => i.Category).HasConversion<int>().IsRequired();
        e.Property(i => i.Source).HasConversion<int>().IsRequired();
        e.Property(i => i.SortOrder).IsRequired();
        e.Property(i => i.CarriedOverFromPreviousWeek).IsRequired();
        // OFF3: Version powers the weak ETag + If-Match concurrency
        // check on the per-item PATCH endpoint; IsConcurrencyToken adds
        // a DB-level race guard for the rare parallel-write case.
        e.Property(i => i.Version).IsRequired().IsConcurrencyToken();
        e.Property(i => i.CreatedAt).IsRequired();
        e.Property(i => i.UpdatedAt).IsRequired();

        e.HasIndex(i => new { i.ShoppingListId, i.Category, i.SortOrder })
            .HasDatabaseName("IX_ShoppingListItems_List_Category_SortOrder");
    }
}
