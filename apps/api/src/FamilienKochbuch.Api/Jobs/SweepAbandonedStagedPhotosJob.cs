using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Infrastructure.Persistence;
using FamilienKochbuch.Infrastructure.Services;
using Hangfire;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace FamilienKochbuch.Api.Jobs;

/// <summary>
/// Hourly Hangfire job that reaps <see cref="Domain.Entities.StagedPhoto"/>
/// rows older than 24h with <c>PromotedAt == null</c>. Blob deletes are
/// per-photo best-effort; the row is removed even when the blob delete
/// fails (an orphan blob without a row is harmless and can be cleaned
/// up manually on SeaweedFS).
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

    /// <summary>Photos older than this without a promotion are reaped.</summary>
    public static readonly TimeSpan AbandonAge = TimeSpan.FromHours(24);

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
        var cutoff = _clock.GetUtcNow() - AbandonAge;

        // Postgres translates the full WHERE server-side; SQLite can't
        // translate DateTimeOffset comparisons so we filter in-memory
        // there. The PromotedAt predicate alone is selective enough
        // that the SQLite fallback stays cheap. We detect SQLite by
        // provider-name string to avoid pulling the SQLite NuGet into
        // the production API assembly just for a test-path check.
        List<StagedPhoto> abandoned;
        var providerName = _db.Database.ProviderName ?? string.Empty;
        if (providerName.Contains("Sqlite", StringComparison.OrdinalIgnoreCase))
        {
            var unpromoted = await _db.StagedPhotos
                .Where(s => s.PromotedAt == null)
                .ToListAsync(ct);
            abandoned = unpromoted.Where(s => s.CreatedAt < cutoff).ToList();
        }
        else
        {
            abandoned = await _db.StagedPhotos
                .Where(s => s.PromotedAt == null && s.CreatedAt < cutoff)
                .ToListAsync(ct);
        }

        if (abandoned.Count == 0)
        {
            _logger.LogInformation(
                "Staged-photo sweep: 0 rows older than {AbandonAge} (cutoff {Cutoff}).",
                AbandonAge, cutoff);
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
            "Staged-photo sweep: reaped {Reaped} row(s) older than {AbandonAge} (blob-errors {BlobErrors}, cutoff {Cutoff}).",
            abandoned.Count, AbandonAge, blobErrors, cutoff);
    }
}
