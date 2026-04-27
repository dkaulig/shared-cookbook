using System.Text.Json;
using SharedCookbook.Domain.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.ChangeTracking;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;

namespace SharedCookbook.Infrastructure.Persistence.Configurations;

/// <summary>
/// EF Core mapping for the <see cref="RecipeImport"/> aggregate. Stores
/// enums as ints (stable across renames), indexes by (UserId, Status)
/// for the "my running imports" query the status endpoint answers, and
/// indexes by CreatedAt for admin reporting / cleanup jobs.
/// </summary>
internal sealed class RecipeImportConfiguration : IEntityTypeConfiguration<RecipeImport>
{
    /// <summary>COVER-0 — serializer options for the
    /// <see cref="RecipeImport.CandidateStagedPhotoIds"/> JSON column.
    /// Compact (no indentation) — the array is typically 0-6 entries
    /// and lives in a single DB cell.</summary>
    private static readonly JsonSerializerOptions CandidateJsonOptions = new()
    {
        WriteIndented = false,
    };


    public void Configure(EntityTypeBuilder<RecipeImport> e)
    {
        e.HasKey(r => r.Id);

        e.Property(r => r.Source).HasConversion<int>();
        e.Property(r => r.Status).HasConversion<int>();
        e.Property(r => r.Progress).IsRequired();

        // PV1 — phase-aware progress. Phase is enum→int on disk (stable
        // across rename refactors, same pattern as Source/Status above).
        // All companion fields are nullable or default-zeroed so this
        // migration can add them without a backfill sweep.
        e.Property(r => r.Phase)
            .HasConversion<int>()
            .HasDefaultValue(SharedCookbook.Domain.Enums.RecipeImportPhase.Queued)
            .IsRequired();
        e.Property(r => r.PhaseProgress).HasDefaultValue(0).IsRequired();
        e.Property(r => r.ProgressLabel)
            .HasMaxLength(RecipeImport.ProgressLabelMaxLength);
        e.Property(r => r.BytesDownloaded);
        e.Property(r => r.BytesTotal);
        e.Property(r => r.SegmentsDone);
        e.Property(r => r.SegmentsTotal);
        e.Property(r => r.AttemptNumber).HasDefaultValue(1).IsRequired();
        e.Property(r => r.LastProgressAt)
            .HasDefaultValueSql("CURRENT_TIMESTAMP")
            .IsRequired();

        // COVER-0 — ordered list of candidate staged-photo ids the
        // URL-import job produced. Stored as a JSON text column (same
        // approach as Recipe.Photos — works identically on Postgres +
        // SQLite, no provider-specific column type). The ValueComparer
        // teaches EF how to detect array mutations for change tracking;
        // without it the Guid[] property would never be considered
        // modified after AttachCandidateStagedPhotos bumps it.
        var candidateConverter = new ValueConverter<Guid[], string>(
            v => JsonSerializer.Serialize(v, CandidateJsonOptions),
            v => JsonSerializer.Deserialize<Guid[]>(v, CandidateJsonOptions) ?? Array.Empty<Guid>());
        var candidateComparer = new ValueComparer<Guid[]>(
            (a, b) => (a ?? Array.Empty<Guid>()).SequenceEqual(b ?? Array.Empty<Guid>()),
            v => v.Aggregate(0, (hash, item) => HashCode.Combine(hash, item.GetHashCode())),
            v => v.ToArray());
        e.Property(r => r.CandidateStagedPhotoIds)
            .HasConversion(candidateConverter)
            .IsRequired()
            .Metadata.SetValueComparer(candidateComparer);

        // REIMPORT-0 — optional FK-like column pointing at the target
        // Recipe the URL-extract job should update in place. Nullable so
        // every pre-reimport import stays valid without backfill; no
        // index because the value is read exclusively inside the job
        // that already has the import row loaded (low cardinality + no
        // hot query path). Intentionally no cascading FK to Recipes —
        // a hard-deleted recipe leaves the import row's
        // TargetRecipeId dangling; the job handles the null-target case
        // explicitly with a `recipe_deleted` error.
        e.Property(r => r.TargetRecipeId);

        e.Property(r => r.SourceUrl).HasMaxLength(RecipeImport.SourceUrlMaxLength);

        // LANG-1 — BCP-47 language code (`de` / `en`). Nullable so
        // pre-LANG-1 rows stay valid without backfill; the runner
        // falls back to "en" when the value is missing. The 2-char
        // cap is enforced both on the column and at domain
        // construction so a malformed value crashes fast.
        e.Property(r => r.RequestedLanguage)
            .HasMaxLength(RecipeImport.RequestedLanguageMaxLength);

        // AI-Normalize toggle (2026-04-27 design). Server-side default of
        // `false` so pre-toggle rows backfill cleanly without a data
        // sweep — the user did not opt in for those, which matches the
        // post-migration "false = no opt-in" semantics. CLR `bool` is
        // already non-nullable in EF Core, so no explicit `.IsRequired()`.
        e.Property(r => r.AiNormalizeActive)
            .HasDefaultValue(false);

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
