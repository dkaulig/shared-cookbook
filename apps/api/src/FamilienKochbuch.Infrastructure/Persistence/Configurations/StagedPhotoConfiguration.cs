using FamilienKochbuch.Domain.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace FamilienKochbuch.Infrastructure.Persistence.Configurations;

/// <summary>
/// PF1 — EF mapping for the <see cref="StagedPhoto"/> aggregate.
///
/// Indexed by <c>(UserId, CreatedAt)</c> so the hourly sweep job can scan
/// abandoned uploads without a sequential table scan, and so the
/// promote handler's <c>WHERE Id IN (...) AND UserId == caller</c>
/// lookup is cheap. Foreign-key on <see cref="StagedPhoto.UserId"/> is
/// <see cref="DeleteBehavior.Restrict"/> — we never want a user delete
/// to silently nuke staged photos it would invalidate (they're
/// unmanaged storage; the sweep job will reap them anyway).
/// </summary>
internal sealed class StagedPhotoConfiguration : IEntityTypeConfiguration<StagedPhoto>
{
    public const int PhotoIdMaxLength = 500;
    public const int SignedUrlMaxLength = 2000;
    public const int ContentTypeMaxLength = 100;

    public void Configure(EntityTypeBuilder<StagedPhoto> e)
    {
        e.HasKey(s => s.Id);

        e.Property(s => s.PhotoId)
            .IsRequired()
            .HasMaxLength(PhotoIdMaxLength);
        e.Property(s => s.SignedUrl)
            .IsRequired()
            .HasMaxLength(SignedUrlMaxLength);
        e.Property(s => s.ContentType)
            .IsRequired()
            .HasMaxLength(ContentTypeMaxLength);

        e.Property(s => s.CreatedAt).IsRequired();
        e.Property(s => s.PromotedAt);
        e.Property(s => s.PromotedToRecipeId);

        // Composite index supporting both (a) the sweep job's "give me
        // abandoned uploads older than N hours" scan and (b) the
        // promote handler's per-user lookup.
        e.HasIndex(s => new { s.UserId, s.CreatedAt });

        e.HasOne<User>()
            .WithMany()
            .HasForeignKey(s => s.UserId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}
