using FamilienKochbuch.Infrastructure.Persistence;
using FamilienKochbuch.Infrastructure.Services;
using Hangfire;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace FamilienKochbuch.Api.Jobs;

/// <summary>
/// PF1 — hourly Hangfire recurring job that reaps abandoned
/// <see cref="Domain.Entities.StagedPhoto"/> rows.
///
/// Selection rule: any row whose <c>CreatedAt</c> is older than 24 hours
/// AND whose <c>PromotedAt</c> is still <c>null</c>. The 24h grace
/// window is intentionally generous — a user can pause mid-import
/// flow for a long lunch break and still have their staged uploads
/// available when they return. Beyond that, the upload is unbounded
/// storage we can't bill back to anyone, so it goes.
///
/// Each row drives two side effects:
/// <list type="number">
///   <item>Best-effort delete of the SeaweedFS blob via
///   <see cref="IPhotoStorage.DeleteAsync"/> (the implementation is
///   idempotent so a missing blob is a no-op).</item>
///   <item>Hard delete of the row.</item>
/// </list>
///
/// Failures during the blob delete are logged + the row is still
/// removed: a stale blob without a row pointing at it is harmless and
/// will get garbage-collected on the next manual SeaweedFS cleanup.
///
/// The job is registered as a Hangfire RecurringJob in <c>Program.cs</c>
/// with a cron of "every hour, 5 minutes past" so it doesn't compete
/// with end-of-hour user activity.
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

        // Query the rows up-front so we can iterate and delete blobs
        // without holding a long-running transaction. Set sizes are
        // tiny in steady state; even a backlog after an outage won't
        // realistically run into the thousands.
        //
        // SQLite can't translate a server-side DateTimeOffset
        // comparison (matches the same limitation called out on the
        // recipe-list endpoint). We pre-filter on PromotedAt server-
        // side and apply the CreatedAt cutoff in-memory; the
        // PromotedAt filter alone is selective enough that the in-mem
        // pass stays cheap on Postgres too.
        var unpromoted = await _db.StagedPhotos
            .Where(s => s.PromotedAt == null)
            .ToListAsync(ct);
        var abandoned = unpromoted.Where(s => s.CreatedAt < cutoff).ToList();

        if (abandoned.Count == 0)
        {
            _logger.LogInformation(
                "PF1 staged-photo sweep: 0 rows older than {AbandonAge} (cutoff {Cutoff}).",
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
                    "PF1 staged-photo sweep: failed to delete blob {PhotoId} for row {RowId}; row will still be removed.",
                    row.PhotoId, row.Id);
            }
        }

        _db.StagedPhotos.RemoveRange(abandoned);
        await _db.SaveChangesAsync(ct);

        _logger.LogInformation(
            "PF1 staged-photo sweep: reaped {Reaped} row(s) older than {AbandonAge} (blob-errors {BlobErrors}, cutoff {Cutoff}).",
            abandoned.Count, AbandonAge, blobErrors, cutoff);
    }
}
