using System.Net;
using FamilienKochbuch.Api.Services;
using FamilienKochbuch.Api.Tests.Infrastructure;
using FamilienKochbuch.Api.Tests.Jobs;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.Enums;
using FamilienKochbuch.Infrastructure.Persistence;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using Xunit;

namespace FamilienKochbuch.Api.Tests.Services;

/// <summary>
/// COVER-0 — unit tests for <see cref="CandidateAttacher"/>. Wires the
/// service against a SQLite in-memory DbContext, a stubbed
/// <see cref="IHttpClientFactory"/> that replays bytes per URL, and a
/// deterministic public-IP resolver so the SSRF guard stays in character
/// without touching the real network.
/// </summary>
public class CandidateAttacherTests : IAsyncLifetime
{
    private SqliteConnection _connection = null!;
    private AppDbContext _db = null!;
    private Guid _userId;
    private Guid _importId;
    private StubHttpMessageHandler _downloadHandler = null!;
    private FakePhotoStorage _photoStorage = null!;
    private FakeTimeProvider _clock = null!;
    private StubExtractorConfigReader _configReader = null!;
    private CandidateAttacher _attacher = null!;

    public async Task InitializeAsync()
    {
        _connection = new SqliteConnection("DataSource=:memory:");
        await _connection.OpenAsync();
        var options = new DbContextOptionsBuilder<AppDbContext>().UseSqlite(_connection).Options;
        _db = new AppDbContext(options);
        await _db.Database.EnsureCreatedAsync();

        var user = new User { Role = UserRole.User };
        user.SetDisplayName("Owner");
        user.SetEmail("owner@example.com");
        var group = new Group("Fam", null, DateTimeOffset.UtcNow);
        _db.Users.Add(user);
        _db.Groups.Add(group);
        await _db.SaveChangesAsync();
        _userId = user.Id;

        // A real import row so the EF insert doesn't trip on an unbacked
        // LinkedImportId in the edge case we query StagedPhoto → import
        // later. (There's no FK constraint but creating the row matches
        // production.)
        var import = new RecipeImport(
            _userId, group.Id, ImportSource.Url, "https://example.com/x",
            DateTimeOffset.UtcNow);
        _db.RecipeImports.Add(import);
        await _db.SaveChangesAsync();
        _importId = import.Id;

        _downloadHandler = new StubHttpMessageHandler();
        var factory = new StubHttpClientFactory(
            _downloadHandler, new Uri("http://unused/"));
        factory.RegisterNamedHandler(CandidateAttacher.HttpClientName, _downloadHandler);

        _photoStorage = new FakePhotoStorage();
        _clock = new FakeTimeProvider(
            new DateTimeOffset(2026, 4, 22, 12, 0, 0, TimeSpan.Zero));
        _configReader = new StubExtractorConfigReader();

        CandidateHostResolver publicResolver = (_, _) =>
            Task.FromResult(new[] { IPAddress.Parse("93.184.216.34") });
        _attacher = new CandidateAttacher(
            _db, factory, _photoStorage, _clock,
            NullLogger<CandidateAttacher>.Instance,
            _configReader,
            publicResolver);
    }

    public async Task DisposeAsync()
    {
        await _db.DisposeAsync();
        await _connection.DisposeAsync();
    }

    private static byte[] FakePngBytes() => new byte[]
    {
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
        0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    };

    [Fact]
    public async Task Empty_Url_List_Returns_Empty_And_Does_Not_Touch_Storage()
    {
        var ids = await _attacher.DownloadAndStageAsync(
            _userId, _importId, Array.Empty<string>(), sourceUrl: null,
            CancellationToken.None);

        Assert.Empty(ids);
        Assert.Empty(_photoStorage.Uploads);
        Assert.Empty(_downloadHandler.Requests);
        Assert.Empty(await _db.StagedPhotos.AsNoTracking().ToListAsync());
    }

    [Fact]
    public async Task Three_Urls_All_Succeed_Returns_Three_Ids_In_Order()
    {
        var urls = new[]
        {
            "https://scontent-fra3-2.xx.fbcdn.net/v/a.jpg",
            "https://scontent-fra3-2.xx.fbcdn.net/v/b.jpg",
            "https://scontent-fra3-2.xx.fbcdn.net/v/c.jpg",
        };
        _downloadHandler.QueueBytesResponse(HttpStatusCode.OK, FakePngBytes(), "image/png");
        _downloadHandler.QueueBytesResponse(HttpStatusCode.OK, FakePngBytes(), "image/png");
        _downloadHandler.QueueBytesResponse(HttpStatusCode.OK, FakePngBytes(), "image/png");

        var ids = await _attacher.DownloadAndStageAsync(
            _userId, _importId, urls, sourceUrl: null, CancellationToken.None);

        Assert.Equal(3, ids.Length);

        var staged = await _db.StagedPhotos.AsNoTracking()
            .Where(s => s.LinkedImportId == _importId)
            .OrderBy(s => s.CandidateOrder)
            .ToListAsync();
        Assert.Equal(3, staged.Count);
        Assert.Equal(0, staged[0].CandidateOrder);
        Assert.Equal(1, staged[1].CandidateOrder);
        Assert.Equal(2, staged[2].CandidateOrder);
        Assert.All(staged, s => Assert.Equal(_userId, s.UserId));
        Assert.All(staged, s => Assert.Equal(_importId, s.LinkedImportId));
        // SourceUrl round-tripped per candidate.
        Assert.Equal(urls, staged.Select(s => s.SourceUrl).ToArray());

        // Returned array ordered by CandidateOrder — identical to the
        // persisted-row ids in that order.
        Assert.Equal(staged.Select(s => s.Id).ToArray(), ids);
    }

    [Fact]
    public async Task Ssrf_Rejected_Url_Is_Skipped_And_Remaining_Urls_Keep_Their_Order()
    {
        // URL[0] on CDN → succeeds. URL[1] not on allowlist (and no
        // SourceUrl to unlock same-origin) → skipped. URL[2] on CDN →
        // succeeds with CandidateOrder = 2. Final returned ids: 2 entries.
        var urls = new[]
        {
            "https://scontent-fra3-2.xx.fbcdn.net/v/a.jpg",
            "https://169.254.169.254/meta",
            "https://i.ytimg.com/vi/abc/hqdefault.jpg",
        };
        _downloadHandler.QueueBytesResponse(HttpStatusCode.OK, FakePngBytes(), "image/png");
        // URL[1] never hits the download handler — the allowlist rejects
        // before any HTTP call, so no response is queued for it.
        _downloadHandler.QueueBytesResponse(HttpStatusCode.OK, FakePngBytes(), "image/png");

        var ids = await _attacher.DownloadAndStageAsync(
            _userId, _importId, urls, sourceUrl: null, CancellationToken.None);

        Assert.Equal(2, ids.Length);

        var staged = await _db.StagedPhotos.AsNoTracking()
            .Where(s => s.LinkedImportId == _importId)
            .OrderBy(s => s.CandidateOrder)
            .ToListAsync();
        Assert.Equal(2, staged.Count);
        // CandidateOrder preserves the ORIGINAL input position — no
        // re-numbering. The frontend grid renderer can use the gap to
        // know the middle tile didn't download.
        Assert.Equal(0, staged[0].CandidateOrder);
        Assert.Equal(2, staged[1].CandidateOrder);

        // Exactly two HTTP requests — the third input URL was rejected
        // before the socket layer.
        Assert.Equal(2, _downloadHandler.Requests.Count);
    }

    [Fact]
    public async Task Oversize_Content_Length_Skips_Single_Candidate_And_Keeps_Others()
    {
        var urls = new[]
        {
            "https://scontent-fra3-2.xx.fbcdn.net/v/big.jpg",
            "https://scontent-fra3-2.xx.fbcdn.net/v/ok.jpg",
        };
        _downloadHandler.QueueBytesResponse(
            HttpStatusCode.OK, FakePngBytes(), "image/png",
            declaredContentLength: CandidateAttacher.MaxBytesPerCandidate + 1);
        _downloadHandler.QueueBytesResponse(HttpStatusCode.OK, FakePngBytes(), "image/png");

        var ids = await _attacher.DownloadAndStageAsync(
            _userId, _importId, urls, sourceUrl: null, CancellationToken.None);

        Assert.Single(ids);
        var staged = await _db.StagedPhotos.AsNoTracking()
            .Where(s => s.LinkedImportId == _importId)
            .SingleAsync();
        // The oversize one was URL[0]; URL[1] survived → CandidateOrder=1.
        Assert.Equal(1, staged.CandidateOrder);
    }

    [Fact]
    public async Task Non_200_Response_Skips_Single_Candidate()
    {
        var urls = new[]
        {
            "https://scontent-fra3-2.xx.fbcdn.net/v/404.jpg",
            "https://scontent-fra3-2.xx.fbcdn.net/v/ok.jpg",
        };
        _downloadHandler.QueueBytesResponse(
            HttpStatusCode.InternalServerError, Array.Empty<byte>(), "text/plain");
        _downloadHandler.QueueBytesResponse(HttpStatusCode.OK, FakePngBytes(), "image/png");

        var ids = await _attacher.DownloadAndStageAsync(
            _userId, _importId, urls, sourceUrl: null, CancellationToken.None);

        Assert.Single(ids);
    }

    [Fact]
    public async Task Non_Image_Content_Type_Skips_Single_Candidate()
    {
        var urls = new[]
        {
            "https://scontent-fra3-2.xx.fbcdn.net/v/html.html",
            "https://scontent-fra3-2.xx.fbcdn.net/v/ok.jpg",
        };
        _downloadHandler.QueueBytesResponse(HttpStatusCode.OK, FakePngBytes(), "text/html");
        _downloadHandler.QueueBytesResponse(HttpStatusCode.OK, FakePngBytes(), "image/png");

        var ids = await _attacher.DownloadAndStageAsync(
            _userId, _importId, urls, sourceUrl: null, CancellationToken.None);

        Assert.Single(ids);
    }

    [Fact]
    public async Task First_Url_Fails_Other_Two_Succeed_Returns_Orders_1_And_2()
    {
        var urls = new[]
        {
            "https://scontent-fra3-2.xx.fbcdn.net/v/fail.jpg",
            "https://scontent-fra3-2.xx.fbcdn.net/v/ok1.jpg",
            "https://scontent-fra3-2.xx.fbcdn.net/v/ok2.jpg",
        };
        _downloadHandler.QueueBytesResponse(
            HttpStatusCode.NotFound, Array.Empty<byte>(), "text/plain");
        _downloadHandler.QueueBytesResponse(HttpStatusCode.OK, FakePngBytes(), "image/png");
        _downloadHandler.QueueBytesResponse(HttpStatusCode.OK, FakePngBytes(), "image/png");

        var ids = await _attacher.DownloadAndStageAsync(
            _userId, _importId, urls, sourceUrl: null, CancellationToken.None);

        Assert.Equal(2, ids.Length);
        var staged = await _db.StagedPhotos.AsNoTracking()
            .Where(s => s.LinkedImportId == _importId)
            .OrderBy(s => s.CandidateOrder)
            .ToListAsync();
        Assert.Equal(new int?[] { 1, 2 }, staged.Select(s => s.CandidateOrder).ToArray());
    }

    [Fact]
    public async Task Feature_Flag_False_Returns_Empty_And_No_Network()
    {
        _configReader.Set(CandidateAttacher.FeatureFlagKey, false);

        var urls = new[] { "https://scontent-fra3-2.xx.fbcdn.net/v/a.jpg" };
        // Deliberately do NOT queue a response — a downstream HTTP call
        // would explode and fail the test.

        var ids = await _attacher.DownloadAndStageAsync(
            _userId, _importId, urls, sourceUrl: null, CancellationToken.None);

        Assert.Empty(ids);
        Assert.Empty(_downloadHandler.Requests);
        Assert.Empty(await _db.StagedPhotos.AsNoTracking().ToListAsync());
    }

    [Fact]
    public async Task Private_Ip_Resolution_Rejects_Same_Origin_Candidate()
    {
        // A hostile blog: attacker owns evil.com (public IP for the
        // source page) but points internal.evil.com at 192.168.1.1. The
        // CDN allowlist misses; same-origin passes by registered domain;
        // DNS guard MUST reject.
        var factory = new StubHttpClientFactory(
            _downloadHandler, new Uri("http://unused/"));
        factory.RegisterNamedHandler(CandidateAttacher.HttpClientName, _downloadHandler);
        CandidateHostResolver privateResolver = (_, _) =>
            Task.FromResult(new[] { IPAddress.Parse("192.168.1.1") });
        var attacher = new CandidateAttacher(
            _db, factory, _photoStorage, _clock,
            NullLogger<CandidateAttacher>.Instance,
            _configReader,
            privateResolver);

        var ids = await attacher.DownloadAndStageAsync(
            _userId, _importId,
            new[] { "https://internal.evil.com/admin.jpg" },
            sourceUrl: "https://evil.com/recipe",
            CancellationToken.None);

        Assert.Empty(ids);
        Assert.Empty(_downloadHandler.Requests);
    }

    [Theory]
    [InlineData("https://scontent-fra3-2.xx.fbcdn.net/v/thumb.jpg", null, true)]
    [InlineData("https://i.ytimg.com/vi/abc/hqdefault.jpg", null, true)]
    [InlineData("https://evilfbcdn.net/x.jpg", null, false)]
    [InlineData("file:///etc/passwd", null, false)]
    [InlineData("ftp://cdn/x", null, false)]
    [InlineData("", null, false)]
    // Same-origin branch.
    [InlineData("https://masonfit.com/hero.jpg", "https://masonfit.com/recipe", true)]
    [InlineData("https://cdn.blog.com/x.jpg", "https://www.blog.com/r", true)]
    [InlineData("https://evil.example/x.jpg", "https://masonfit.com/r", false)]
    public void Host_Allowlist_Matches_Thumbnail_Attacher_Posture(
        string url, string? sourceUrl, bool expected)
    {
        Assert.Equal(expected,
            CandidateAttacher.IsAllowedHostForImport(url, sourceUrl, out _));
    }

    // COVER-0 fix — the python-extractor serves ffmpeg-extracted video
    // frames via its own HTTP endpoint. The downloader treats the
    // docker-internal hostname as an exact-match allowlist entry that
    // bypasses the CDN suffix + DNS public-IP checks (the target IP is
    // always private 172.28.x.x by design).

    [Fact]
    public async Task Internal_Host_Url_Bypasses_Cdn_Allowlist_And_Dns_Check()
    {
        var attacher = new CandidateAttacher(
            _db, BuildFactory(), _photoStorage, _clock,
            NullLogger<CandidateAttacher>.Instance,
            _configReader,
            // Private resolver — the fact that the fetch succeeds
            // proves the internal-host branch skipped the public-IP
            // gate. A non-internal host would get rejected here.
            (_, _) => Task.FromResult(new[] { IPAddress.Parse("172.28.0.7") }),
            allowedInternalHosts: new[] { "python-extractor" });

        _downloadHandler.QueueBytesResponse(
            HttpStatusCode.OK, FakePngBytes(), "image/jpeg");

        var urls = new[]
        {
            "http://python-extractor:8000/extractor/frames/abc-123/0.jpg",
        };
        var ids = await attacher.DownloadAndStageAsync(
            _userId, _importId, urls, sourceUrl: "https://facebook.com/x",
            CancellationToken.None);

        Assert.Single(ids);
        Assert.Single(_downloadHandler.Requests);
    }

    [Fact]
    public async Task Internal_Host_Allowlist_Requires_Exact_Match_Not_Suffix()
    {
        // "evil-python-extractor" ends in "python-extractor" but is NOT
        // an exact match. The bypass must fire only on an exact hostname
        // match; a naive suffix check would let an attacker with a
        // controlled registered domain hop the allowlist.
        var attacher = new CandidateAttacher(
            _db, BuildFactory(), _photoStorage, _clock,
            NullLogger<CandidateAttacher>.Instance,
            _configReader,
            (_, _) => Task.FromResult(new[] { IPAddress.Parse("93.184.216.34") }),
            allowedInternalHosts: new[] { "python-extractor" });

        // evil-python-extractor is not on the CDN allowlist either, so
        // with no sourceUrl same-origin escape the URL should be
        // skipped before the HTTP layer.
        var urls = new[]
        {
            "http://evil-python-extractor:8000/extractor/frames/abc/0.jpg",
        };
        var ids = await attacher.DownloadAndStageAsync(
            _userId, _importId, urls, sourceUrl: null,
            CancellationToken.None);

        Assert.Empty(ids);
        Assert.Empty(_downloadHandler.Requests);
    }

    [Fact]
    public async Task Internal_Host_Allowlist_Does_Not_Widen_Private_Ip_Gate_For_Other_Hosts()
    {
        // A random other host that resolves to a private IP must still
        // be rejected. The internal-host bypass is narrow — only the
        // exact hostname(s) we configured hop the DNS check.
        var attacher = new CandidateAttacher(
            _db, BuildFactory(), _photoStorage, _clock,
            NullLogger<CandidateAttacher>.Instance,
            _configReader,
            (_, _) => Task.FromResult(new[] { IPAddress.Parse("192.168.1.1") }),
            allowedInternalHosts: new[] { "python-extractor" });

        // Use a same-origin pair so IsAllowedHostForImport accepts the
        // URL — the DNS check is what must then reject it.
        var urls = new[] { "https://internal.evil.com/admin.jpg" };
        var ids = await attacher.DownloadAndStageAsync(
            _userId, _importId, urls, sourceUrl: "https://evil.com/recipe",
            CancellationToken.None);

        Assert.Empty(ids);
        Assert.Empty(_downloadHandler.Requests);
    }

    [Fact]
    public async Task Internal_Host_Allowlist_Refuses_Non_Http_Schemes()
    {
        var attacher = new CandidateAttacher(
            _db, BuildFactory(), _photoStorage, _clock,
            NullLogger<CandidateAttacher>.Instance,
            _configReader,
            (_, _) => Task.FromResult(new[] { IPAddress.Parse("172.28.0.7") }),
            allowedInternalHosts: new[] { "python-extractor" });

        // file:// / ftp:// / data:// must never slip through even if the
        // host portion looks internal — scheme check is load-bearing.
        var urls = new[]
        {
            "file://python-extractor/etc/passwd",
            "ftp://python-extractor:21/0.jpg",
        };
        var ids = await attacher.DownloadAndStageAsync(
            _userId, _importId, urls, sourceUrl: null,
            CancellationToken.None);

        Assert.Empty(ids);
        Assert.Empty(_downloadHandler.Requests);
    }

    [Fact]
    public async Task Internal_Host_Mixed_With_Cdn_Url_Both_Succeed()
    {
        var attacher = new CandidateAttacher(
            _db, BuildFactory(), _photoStorage, _clock,
            NullLogger<CandidateAttacher>.Instance,
            _configReader,
            // Resolver returns a public IP for any host — the
            // internal-host branch would bypass this anyway, but the
            // CDN URL needs it to pass the public-IP gate.
            (_, _) => Task.FromResult(new[] { IPAddress.Parse("93.184.216.34") }),
            allowedInternalHosts: new[] { "python-extractor" });

        var urls = new[]
        {
            "https://scontent-fra3-2.xx.fbcdn.net/v/a.jpg",
            "http://python-extractor:8000/extractor/frames/abc/0.jpg",
        };
        _downloadHandler.QueueBytesResponse(HttpStatusCode.OK, FakePngBytes(), "image/jpeg");
        _downloadHandler.QueueBytesResponse(HttpStatusCode.OK, FakePngBytes(), "image/jpeg");

        var ids = await attacher.DownloadAndStageAsync(
            _userId, _importId, urls, sourceUrl: null,
            CancellationToken.None);

        Assert.Equal(2, ids.Length);
    }

    private StubHttpClientFactory BuildFactory()
    {
        var factory = new StubHttpClientFactory(_downloadHandler, new Uri("http://unused/"));
        factory.RegisterNamedHandler(CandidateAttacher.HttpClientName, _downloadHandler);
        return factory;
    }
}
