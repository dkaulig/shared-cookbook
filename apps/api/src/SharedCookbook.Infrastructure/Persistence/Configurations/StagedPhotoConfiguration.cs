using SharedCookbook.Domain.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace SharedCookbook.Infrastructure.Persistence.Configurations;

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

    /// <summary>BUG-048 — upper bound for <see cref="StagedPhoto.SourceUrl"/>.
    /// Matches <c>Recipe.SourceUrlMaxLength</c> so a legitimate extractor
    /// thumbnail URL always fits.</summary>
    public const int SourceUrlMaxLength = 2000;

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
        // BUG-048 — nullable; user-uploaded staged photos never carry a
        // source URL. Indexed together with PromotedToRecipeId below so
        // the reimport dedupe lookup is cheap.
        e.Property(s => s.SourceUrl)
            .HasMaxLength(SourceUrlMaxLength);

        // COVER-0 — nullable import linkage + 0-indexed position within
        // the import's candidate cohort. No FK constraint: the
        // RecipeImport row is kept indefinitely as an audit trail and
        // we don't want a cascade to NULL the column out from under a
        // sweep run. Index below supports the sweep's 7-day branch + the
        // /api/imports/:id/candidates endpoint.
        e.Property(s => s.LinkedImportId);
        e.Property(s => s.CandidateOrder);

        // Composite index supporting both (a) the sweep job's "give me
        // abandoned uploads older than N hours" scan and (b) the
        // promote handler's per-user lookup.
        e.HasIndex(s => new { s.UserId, s.CreatedAt });

        // BUG-048 — composite index on (PromotedToRecipeId, SourceUrl)
        // backs the reimport dedupe query "has this recipe already
        // adopted a staged photo from this origin URL?". Both columns
        // are nullable; the lookup only runs when both sides are known.
        e.HasIndex(s => new { s.PromotedToRecipeId, s.SourceUrl });

        // COVER-0 — index on LinkedImportId. Hot for both the sweep's
        // 7-day branch (filter where LinkedImportId IS NOT NULL) and
        // the /api/imports/:id/candidates endpoint (pull every row
        // linked to one import).
        e.HasIndex(s => s.LinkedImportId);

        e.HasOne<User>()
            .WithMany()
            .HasForeignKey(s => s.UserId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}
