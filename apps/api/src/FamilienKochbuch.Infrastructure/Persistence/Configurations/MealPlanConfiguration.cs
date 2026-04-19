using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.MealPlanning;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace FamilienKochbuch.Infrastructure.Persistence.Configurations;

/// <summary>
/// EF Core mapping for the <see cref="MealPlan"/> aggregate (P3-0). One row
/// per (<see cref="MealPlan.GroupId"/>, <see cref="MealPlan.WeekStart"/>)
/// enforced by a unique index so two concurrent clients can't race a plan
/// into existence for the same week.
/// Group FK is <see cref="DeleteBehavior.Restrict"/>: groups stay soft-
/// delete only, and we don't want a hard-delete of a group to silently
/// cascade through its meal plans.
/// </summary>
internal sealed class MealPlanConfiguration : IEntityTypeConfiguration<MealPlan>
{
    public void Configure(EntityTypeBuilder<MealPlan> e)
    {
        e.HasKey(p => p.Id);

        e.Property(p => p.GroupId).IsRequired();
        e.Property(p => p.WeekStart).IsRequired();
        e.Property(p => p.Version).IsRequired();
        e.Property(p => p.CreatedAt).IsRequired();
        e.Property(p => p.UpdatedAt).IsRequired();

        // One plan per (Group, Week). P3-1's POST handler idempotently
        // returns the existing row instead of colliding on insert.
        e.HasIndex(p => new { p.GroupId, p.WeekStart })
            .IsUnique()
            .HasDatabaseName("IX_MealPlans_Group_WeekStart_Unique");

        e.HasOne<Group>()
            .WithMany()
            .HasForeignKey(p => p.GroupId)
            .OnDelete(DeleteBehavior.Restrict);

        e.HasMany(p => p.Slots)
            .WithOne(s => s.MealPlan!)
            .HasForeignKey(s => s.MealPlanId)
            .OnDelete(DeleteBehavior.Cascade);
    }
}
