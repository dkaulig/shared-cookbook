using FamilienKochbuch.Domain.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace FamilienKochbuch.Infrastructure.Persistence.Configurations;

/// <summary>
/// EF Core mapping for the <see cref="RecipeImport"/> aggregate. Stores
/// enums as ints (stable across renames), indexes by (UserId, Status)
/// for the "my running imports" query the status endpoint answers, and
/// indexes by CreatedAt for admin reporting / cleanup jobs.
/// </summary>
internal sealed class RecipeImportConfiguration : IEntityTypeConfiguration<RecipeImport>
{
    public void Configure(EntityTypeBuilder<RecipeImport> e)
    {
        e.HasKey(r => r.Id);

        e.Property(r => r.Source).HasConversion<int>();
        e.Property(r => r.Status).HasConversion<int>();
        e.Property(r => r.Progress).IsRequired();

        e.Property(r => r.SourceUrl).HasMaxLength(RecipeImport.SourceUrlMaxLength);

        // ResultJson is arbitrary length (could be ~50KB for a big
        // recipe); no cap. PostgreSQL stores as text; SQLite as TEXT.
        e.Property(r => r.ResultJson);

        e.Property(r => r.ErrorMessage).HasMaxLength(RecipeImport.ErrorMessageMaxLength);

        // Token-usage tracking — all four columns are nullable so
        // existing rows (pre-migration) and error-path imports (where
        // no LLM call happened) stay NULL rather than pretending to
        // have zero-cost usage.
        e.Property(r => r.ModelDeployment).HasMaxLength(RecipeImport.ModelDeploymentMaxLength);

        // Index supporting "give me this user's imports ordered by recency".
        e.HasIndex(r => new { r.UserId, r.CreatedAt });
        e.HasIndex(r => r.Status);

        // FK to the owning user — Restrict so deleting a user forces an
        // explicit decision about their in-flight imports rather than
        // a surprise cascade.
        e.HasOne<User>()
            .WithMany()
            .HasForeignKey(r => r.UserId)
            .OnDelete(DeleteBehavior.Restrict);

        e.HasOne<Group>()
            .WithMany()
            .HasForeignKey(r => r.GroupId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}
