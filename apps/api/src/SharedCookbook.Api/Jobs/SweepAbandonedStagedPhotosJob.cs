using SharedCookbook.Domain.Entities;
using SharedCookbook.Infrastructure.Persistence;
using SharedCookbook.Infrastructure.Services;
using Hangfire;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace SharedCookbook.Api.Jobs;

/// <summary>
/// Hourly Hangfire job that reaps abandoned
/// <see cref="Domain.Entities.StagedPhoto"/> rows. Two TTL branches
/// (COVER-0):
/// <list type="bullet">
/// <item>User-uploaded rows (<c>LinkedImportId IS NULL</c>) reap at
///   <see cref="AbandonAge"/> = 24h. Matches the original PF1 contract.</item>
/// <item>Import-candidate rows (<c>LinkedImportId IS NOT NULL</c>)
///   reap at <see cref="CandidateAbandonAge"/> = 7d. Keeps the
///   "Cover ändern" flow on the recipe detail page working for a week
///   after the initial save.</item>
/// </list>
/// Promoted rows (<c>PromotedAt IS NOT NULL</c>) are never reaped —
/// they're the audit trail for an attached recipe photo.
///
/// Blob deletes are per-photo best-effort; the row is removed even when
/// the blob delete fails (an orphan blob without a row is harmless and
/// can be cleaned up manually on SeaweedFS).
/// </summary>
public class SweepAbandonedStagedPhotosJob
{
    /// <summary>
    /// Hangfire recurring-job id; stable across deploys so a re-deploy
    /// updates the existing schedule rather than creating a duplicate.
    /// </summary>
    public const string RecurringJobId = "sweep-abandoned-staged-photos";

    /// <summary>Cron expression — top of every hour at minute 5.</summary>
    public const string CronExpression = "5 * * * *";

    /// <summary>User-uploaded photos (LinkedImportId IS NULL) older than
    /// this without a promotion are reaped. 24h matches the original PF1
    /// contract: the user's import-review flow typically finishes in
    /// minutes; a day is the conservative eventual-consistency bound.</summary>
    public static readonly TimeSpan AbandonAge = TimeSpan.FromHours(24);

    /// <summary>COVER-0 — import-candidate rows (LinkedImportId IS NOT NULL)
    /// get a longer TTL so the "Cover ändern" flow on the recipe detail
    /// page keeps working for a week after save. Matches the design doc's
    /// explicit 7-day window. Promoted rows are never reaped regardless
    /// of age; this TTL only applies while PromotedAt IS NULL.</summary>
    public static readonly TimeSpan CandidateAbandonAge = TimeSpan.FromDays(7);

    private readonly AppDbContext _db;
    private readonly IPhotoStorage _photoStorage;
    private readonly TimeProvider _clock;
    private readonly ILogger<SweepAbandonedStagedPhotosJob> _logger;

    public SweepAbandonedStagedPhotosJob(
        AppDbContext db,
        IPhotoStorage photoStorage,
        TimeProvider clock,
        ILogger<SweepAbandonedStagedPhotosJob> logger)
    {
        _db = db;
        _photoStorage = photoStorage;
        _clock = clock;
        _logger = logger;
    }

    /// <summary>Entry point Hangfire invokes on the schedule.
    /// <c>DisableConcurrentExecution</c> guards against overlap when a
    /// run takes longer than the recurrence interval (e.g. the filer
    /// is slow).</summary>
    [DisableConcurrentExecution(timeoutInSeconds: 60)]
    public async Task ExecuteAsync(CancellationToken ct)
    {
        var now = _clock.GetUtcNow();
        var userUploadCutoff = now - AbandonAge;
        var candidateCutoff = now - CandidateAbandonAge;

        // COVER-0 — two TTL branches:
        //  • LinkedImportId IS NULL → user-uploaded, 24h rule.
        //  • LinkedImportId IS NOT NULL → import candidate, 7-day rule.
        // Promoted rows are never reaped (PromotedAt IS NULL is the
        // common precondition). Postgres translates the full WHERE
        // server-side; SQLite (test provider) can't compare
        // DateTimeOffset at the SQL layer so we pull unpromoted rows +
        // filter in memory — the PromotedAt predicate alone is
        // selective enough to keep the fallback cheap.
        List<StagedPhoto> abandoned;
        var providerName = _db.Database.ProviderName ?? string.Empty;
        if (providerName.Contains("Sqlite", StringComparison.OrdinalIgnoreCase))
        {
            var unpromoted = await _db.StagedPhotos
                .Where(s => s.PromotedAt == null)
                .ToListAsync(ct);
            abandoned = unpromoted.Where(s =>
                (s.LinkedImportId == null && s.CreatedAt < userUploadCutoff)
                || (s.LinkedImportId != null && s.CreatedAt < candidateCutoff))
                .ToList();
        }
        else
        {
            abandoned = await _db.StagedPhotos
                .Where(s => s.PromotedAt == null
                    && ((s.LinkedImportId == null && s.CreatedAt < userUploadCutoff)
                        || (s.LinkedImportId != null && s.CreatedAt < candidateCutoff)))
                .ToListAsync(ct);
        }

        if (abandoned.Count == 0)
        {
            _logger.LogInformation(
                "Staged-photo sweep: 0 rows past either TTL (user cutoff {UserCutoff}, candidate cutoff {CandCutoff}).",
                userUploadCutoff, candidateCutoff);
            return;
        }

        var blobErrors = 0;
        foreach (var row in abandoned)
        {
            try
            {
                await _photoStorage.DeleteAsync(row.PhotoId, ct);
            }
            catch (Exception ex)
            {
                blobErrors++;
                _logger.LogWarning(ex,
                    "Staged-photo sweep: failed to delete blob {PhotoId} for row {RowId}; row will still be removed.",
                    row.PhotoId, row.Id);
            }
        }

        _db.StagedPhotos.RemoveRange(abandoned);
        await _db.SaveChangesAsync(ct);

        _logger.LogInformation(
            "Staged-photo sweep: reaped {Reaped} row(s) across both TTL branches (blob-errors {BlobErrors}, user cutoff {UserCutoff}, candidate cutoff {CandCutoff}).",
            abandoned.Count, blobErrors, userUploadCutoff, candidateCutoff);
    }
}
