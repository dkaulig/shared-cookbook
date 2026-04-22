using FamilienKochbuch.Api.Jobs;
using FamilienKochbuch.Api.Tests.Infrastructure;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Infrastructure.Persistence;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using Xunit;

namespace FamilienKochbuch.Api.Tests.Jobs;

/// <summary>
/// PF1 — unit tests for the recurring staged-photo sweep job. We
/// exercise the job's <see cref="SweepAbandonedStagedPhotosJob.ExecuteAsync"/>
/// directly against a SQLite-backed AppDbContext + a frozen
/// <see cref="FakeTimeProvider"/> so the 24h cutoff is deterministic.
///
/// We don't spin up a real Hangfire server here — the recurring-job
/// registration + cron schedule live in <c>Program.cs</c>; if the
/// invocation contract changes we'd see failures from the
/// <c>RecurringJob.AddOrUpdate</c> call site at boot. The behaviour
/// the user cares about (which rows get reaped, which blobs get
/// deleted) is fully covered here.
/// </summary>
public class SweepAbandonedStagedPhotosJobTests : IAsyncLifetime
{
    private SqliteConnection _connection = null!;
    private AppDbContext _db = null!;
    private FakePhotoStorage _storage = null!;
    private FakeTimeProvider _clock = null!;
    private SweepAbandonedStagedPhotosJob _job = null!;
    private Guid _userId;

    public async Task InitializeAsync()
    {
        _connection = new SqliteConnection("DataSource=:memory:");
        await _connection.OpenAsync();
        var options = new DbContextOptionsBuilder<AppDbContext>().UseSqlite(_connection).Options;
        _db = new AppDbContext(options);
        await _db.Database.EnsureCreatedAsync();

        var user = new User { Role = Domain.Enums.UserRole.User };
        user.SetDisplayName("Sweep Owner");
        user.SetEmail("sweep@example.com");
        _db.Users.Add(user);
        await _db.SaveChangesAsync();
        _userId = user.Id;

        _storage = new FakePhotoStorage();
        // Anchor the test clock at a stable mid-day UTC moment so the
        // 24h cutoff math is easy to reason about.
        _clock = new FakeTimeProvider(new DateTimeOffset(2026, 4, 19, 12, 0, 0, TimeSpan.Zero));
        _job = new SweepAbandonedStagedPhotosJob(
            _db, _storage, _clock, NullLogger<SweepAbandonedStagedPhotosJob>.Instance);
    }

    public async Task DisposeAsync()
    {
        await _db.DisposeAsync();
        await _connection.DisposeAsync();
    }

    private async Task<StagedPhoto> SeedStagedPhotoAsync(
        DateTimeOffset createdAt,
        DateTimeOffset? promotedAt = null,
        Guid? promotedToRecipeId = null,
        string photoIdSuffix = "abc",
        Guid? linkedImportId = null,
        int? candidateOrder = null)
    {
        var path = $"recipes/staged-{photoIdSuffix}.jpg";
        // Pre-populate the storage fake so DeleteAsync round-trips.
        _storage.Uploads[path] = (new byte[] { 1, 2, 3 }, "image/jpeg");

        var staged = new StagedPhoto(
            userId: _userId,
            photoId: path,
            signedUrl: $"/api/photos/{path}?sig=x&exp=9",
            contentType: "image/jpeg",
            createdAt: createdAt,
            linkedImportId: linkedImportId,
            candidateOrder: candidateOrder);
        if (promotedAt is not null)
            staged.MarkPromoted(promotedToRecipeId ?? Guid.NewGuid(), promotedAt.Value);
        _db.StagedPhotos.Add(staged);
        await _db.SaveChangesAsync();
        return staged;
    }

    [Fact]
    public async Task ExecuteAsync_Reaps_Rows_Older_Than_24h_With_Null_Promotion()
    {
        // 25h ago → reapable.
        var ancient = await SeedStagedPhotoAsync(
            createdAt: _clock.GetUtcNow() - TimeSpan.FromHours(25),
            photoIdSuffix: "ancient");

        await _job.ExecuteAsync(CancellationToken.None);

        Assert.False(await _db.StagedPhotos.AnyAsync(s => s.Id == ancient.Id));
        Assert.False(_storage.Uploads.ContainsKey(ancient.PhotoId));
        Assert.Contains(ancient.PhotoId, _storage.Deleted);
    }

    [Fact]
    public async Task ExecuteAsync_Leaves_Recent_Rows_Alone()
    {
        // 23h ago → still inside the grace window.
        var recent = await SeedStagedPhotoAsync(
            createdAt: _clock.GetUtcNow() - TimeSpan.FromHours(23),
            photoIdSuffix: "recent");

        await _job.ExecuteAsync(CancellationToken.None);

        Assert.True(await _db.StagedPhotos.AnyAsync(s => s.Id == recent.Id));
        Assert.True(_storage.Uploads.ContainsKey(recent.PhotoId));
    }

    [Fact]
    public async Task ExecuteAsync_Leaves_Promoted_Rows_Alone_Even_When_Old()
    {
        // 30h ago BUT already promoted — must NOT be reaped (the row
        // is the audit trail for an attached photo).
        var promoted = await SeedStagedPhotoAsync(
            createdAt: _clock.GetUtcNow() - TimeSpan.FromHours(30),
            promotedAt: _clock.GetUtcNow() - TimeSpan.FromHours(28),
            photoIdSuffix: "promoted");

        await _job.ExecuteAsync(CancellationToken.None);

        Assert.True(await _db.StagedPhotos.AnyAsync(s => s.Id == promoted.Id));
        // The promoted row's blob is the staged source — sweep must
        // not touch it; the promote handler already best-effort
        // deletes after a successful copy.
        Assert.True(_storage.Uploads.ContainsKey(promoted.PhotoId));
    }

    [Fact]
    public async Task ExecuteAsync_Mixed_Set_Only_Reaps_Eligible()
    {
        var ancientUnpromoted = await SeedStagedPhotoAsync(
            createdAt: _clock.GetUtcNow() - TimeSpan.FromHours(48),
            photoIdSuffix: "old1");
        var ancientPromoted = await SeedStagedPhotoAsync(
            createdAt: _clock.GetUtcNow() - TimeSpan.FromHours(48),
            promotedAt: _clock.GetUtcNow() - TimeSpan.FromHours(40),
            photoIdSuffix: "old2");
        var recent = await SeedStagedPhotoAsync(
            createdAt: _clock.GetUtcNow() - TimeSpan.FromMinutes(30),
            photoIdSuffix: "fresh");

        await _job.ExecuteAsync(CancellationToken.None);

        Assert.False(await _db.StagedPhotos.AnyAsync(s => s.Id == ancientUnpromoted.Id));
        Assert.True(await _db.StagedPhotos.AnyAsync(s => s.Id == ancientPromoted.Id));
        Assert.True(await _db.StagedPhotos.AnyAsync(s => s.Id == recent.Id));

        Assert.Contains(ancientUnpromoted.PhotoId, _storage.Deleted);
        Assert.DoesNotContain(ancientPromoted.PhotoId, _storage.Deleted);
        Assert.DoesNotContain(recent.PhotoId, _storage.Deleted);
    }

    [Fact]
    public async Task ExecuteAsync_Empty_Table_Is_A_NoOp()
    {
        await _job.ExecuteAsync(CancellationToken.None);
        Assert.Empty(_storage.Deleted);
    }

    // ── COVER-0: 7-day branch for import-candidate rows ─────────────

    [Fact]
    public async Task ExecuteAsync_COVER0_Keeps_Candidate_Rows_Younger_Than_7_Days()
    {
        // 6 days old, LinkedImportId set → still within the 7-day
        // "cover ändern" window → must NOT be reaped.
        var importId = Guid.NewGuid();
        var sixDaysOld = await SeedStagedPhotoAsync(
            createdAt: _clock.GetUtcNow() - TimeSpan.FromDays(6),
            photoIdSuffix: "c-6d",
            linkedImportId: importId,
            candidateOrder: 0);

        await _job.ExecuteAsync(CancellationToken.None);

        Assert.True(await _db.StagedPhotos.AnyAsync(s => s.Id == sixDaysOld.Id));
        Assert.True(_storage.Uploads.ContainsKey(sixDaysOld.PhotoId));
    }

    [Fact]
    public async Task ExecuteAsync_COVER0_Reaps_Candidate_Rows_Older_Than_7_Days()
    {
        // 8 days old, LinkedImportId set → past the 7-day window →
        // sweep reaps the row and deletes the blob.
        var importId = Guid.NewGuid();
        var eightDaysOld = await SeedStagedPhotoAsync(
            createdAt: _clock.GetUtcNow() - TimeSpan.FromDays(8),
            photoIdSuffix: "c-8d",
            linkedImportId: importId,
            candidateOrder: 0);

        await _job.ExecuteAsync(CancellationToken.None);

        Assert.False(await _db.StagedPhotos.AnyAsync(s => s.Id == eightDaysOld.Id));
        Assert.Contains(eightDaysOld.PhotoId, _storage.Deleted);
    }

    [Fact]
    public async Task ExecuteAsync_COVER0_Candidate_25h_Old_Is_Not_Reaped_Yet()
    {
        // A candidate row that's >24h old must NOT be reaped as though
        // the legacy 24h rule still applied to it. The LinkedImportId
        // non-null branch is authoritative and kicks in at 7 days.
        var importId = Guid.NewGuid();
        var justOver24h = await SeedStagedPhotoAsync(
            createdAt: _clock.GetUtcNow() - TimeSpan.FromHours(25),
            photoIdSuffix: "c-25h",
            linkedImportId: importId,
            candidateOrder: 0);

        await _job.ExecuteAsync(CancellationToken.None);

        Assert.True(await _db.StagedPhotos.AnyAsync(s => s.Id == justOver24h.Id));
    }

    [Fact]
    public async Task ExecuteAsync_COVER0_Promoted_Candidate_Never_Reaped()
    {
        // Promoted-with-LinkedImportId row (the [0] cover that was
        // auto-attached onto the recipe during the reimport flow) must
        // stay put — promoted rows are audit trail and the blob was
        // already moved into the recipe namespace.
        var importId = Guid.NewGuid();
        var promoted = await SeedStagedPhotoAsync(
            createdAt: _clock.GetUtcNow() - TimeSpan.FromDays(30),
            promotedAt: _clock.GetUtcNow() - TimeSpan.FromDays(29),
            photoIdSuffix: "c-promoted",
            linkedImportId: importId,
            candidateOrder: 0);

        await _job.ExecuteAsync(CancellationToken.None);

        Assert.True(await _db.StagedPhotos.AnyAsync(s => s.Id == promoted.Id));
        Assert.DoesNotContain(promoted.PhotoId, _storage.Deleted);
    }

    [Fact]
    public async Task ExecuteAsync_COVER0_Two_Branches_Coexist()
    {
        // Mixed cohort exercising both TTL branches in a single run:
        //  - ancient un-linked    → reaped (24h rule)
        //  - ancient candidate    → reaped (7d rule)
        //  - fresh candidate      → kept
        //  - fresh un-linked      → kept
        //  - ancient promoted     → kept (audit trail)
        var importId = Guid.NewGuid();
        var ancientUnlinked = await SeedStagedPhotoAsync(
            createdAt: _clock.GetUtcNow() - TimeSpan.FromHours(48),
            photoIdSuffix: "u-old");
        var ancientCandidate = await SeedStagedPhotoAsync(
            createdAt: _clock.GetUtcNow() - TimeSpan.FromDays(10),
            photoIdSuffix: "c-old",
            linkedImportId: importId,
            candidateOrder: 0);
        var freshCandidate = await SeedStagedPhotoAsync(
            createdAt: _clock.GetUtcNow() - TimeSpan.FromDays(3),
            photoIdSuffix: "c-fresh",
            linkedImportId: importId,
            candidateOrder: 1);
        var freshUnlinked = await SeedStagedPhotoAsync(
            createdAt: _clock.GetUtcNow() - TimeSpan.FromHours(2),
            photoIdSuffix: "u-fresh");
        var ancientPromoted = await SeedStagedPhotoAsync(
            createdAt: _clock.GetUtcNow() - TimeSpan.FromDays(20),
            promotedAt: _clock.GetUtcNow() - TimeSpan.FromDays(19),
            photoIdSuffix: "p-old");

        await _job.ExecuteAsync(CancellationToken.None);

        Assert.False(await _db.StagedPhotos.AnyAsync(s => s.Id == ancientUnlinked.Id));
        Assert.False(await _db.StagedPhotos.AnyAsync(s => s.Id == ancientCandidate.Id));
        Assert.True(await _db.StagedPhotos.AnyAsync(s => s.Id == freshCandidate.Id));
        Assert.True(await _db.StagedPhotos.AnyAsync(s => s.Id == freshUnlinked.Id));
        Assert.True(await _db.StagedPhotos.AnyAsync(s => s.Id == ancientPromoted.Id));

        Assert.Contains(ancientUnlinked.PhotoId, _storage.Deleted);
        Assert.Contains(ancientCandidate.PhotoId, _storage.Deleted);
        Assert.DoesNotContain(freshCandidate.PhotoId, _storage.Deleted);
        Assert.DoesNotContain(freshUnlinked.PhotoId, _storage.Deleted);
        Assert.DoesNotContain(ancientPromoted.PhotoId, _storage.Deleted);
    }

    [Fact]
    public async Task ExecuteAsync_Removes_Row_Even_When_Blob_Delete_Throws()
    {
        // Seed an abandoned row, then make the storage fake's DeleteAsync
        // throw by removing the upload entry to force a miss + override
        // — actually the fake's DeleteAsync is silent on misses; to
        // exercise the swallow-and-continue path we wire a custom fake.
        var abandoned = await SeedStagedPhotoAsync(
            createdAt: _clock.GetUtcNow() - TimeSpan.FromHours(48),
            photoIdSuffix: "boom");

        var throwingStorage = new ThrowingPhotoStorage(_storage);
        var job = new SweepAbandonedStagedPhotosJob(
            _db, throwingStorage, _clock,
            NullLogger<SweepAbandonedStagedPhotosJob>.Instance);

        await job.ExecuteAsync(CancellationToken.None);

        // Even though the blob delete blew up, the row is gone — the
        // sweep job's contract is to free up the DB slot regardless.
        Assert.False(await _db.StagedPhotos.AnyAsync(s => s.Id == abandoned.Id));
    }

    /// <summary>
    /// Adapter that delegates to a real <see cref="FakePhotoStorage"/>
    /// for upload + url-shape behaviour but throws on delete so the
    /// sweep job's "swallow + continue" branch is exercised.
    /// </summary>
    private sealed class ThrowingPhotoStorage : FamilienKochbuch.Infrastructure.Services.IPhotoStorage
    {
        private readonly FakePhotoStorage _inner;
        public ThrowingPhotoStorage(FakePhotoStorage inner) => _inner = inner;

        public Task<string> UploadAsync(
            Stream content, string contentType, string originalFileName, CancellationToken ct = default)
            => _inner.UploadAsync(content, contentType, originalFileName, ct);

        public Task DeleteAsync(string pathOrUrl, CancellationToken ct = default)
            => throw new InvalidOperationException("Filer is on fire.");

        public string GetPublicUrl(string path) => _inner.GetPublicUrl(path);

        public Task<string> CopyAsync(
            string sourcePath, string contentType, CancellationToken ct = default)
            => _inner.CopyAsync(sourcePath, contentType, ct);
    }
}
