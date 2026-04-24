using System.Net;
using System.Text.Json;
using FamilienKochbuch.Api.Jobs;
using FamilienKochbuch.Api.Services;
using FamilienKochbuch.Api.Tests.Infrastructure;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.Enums;
using FamilienKochbuch.Infrastructure.Persistence;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Time.Testing;
using Xunit;

namespace FamilienKochbuch.Api.Tests.Jobs;

/// <summary>
/// Integration-style tests for <see cref="ExtractRecipeFromUrlJob"/>.
/// Wires the job against:
/// <list type="bullet">
/// <item>A SQLite in-memory <see cref="AppDbContext"/> seeded with a
/// <see cref="RecipeImport"/> row.</item>
/// <item>A stubbed <see cref="IHttpClientFactory"/> that replays
/// scripted responses from the Python service.</item>
/// <item>A real <see cref="ExtractorHmacSigner"/> so we can assert the
/// three wire headers actually land on the outgoing request.</item>
/// </list>
///
/// These tests exercise the happy path, the terminal 4xx path, the
/// retryable 5xx path, and malformed-JSON handling. Hangfire itself
/// isn't in the loop — the job's <c>ExecuteAsync</c> is invoked
/// directly because that's exactly what Hangfire would do at runtime.
/// </summary>
public class ExtractRecipeFromUrlJobTests : IAsyncLifetime
{
    private SqliteConnection _connection = null!;
    private AppDbContext _db = null!;
    private Guid _userId;
    private Guid _groupId;
    private StubHttpMessageHandler _handler = null!;
    private StubHttpMessageHandler _thumbnailHandler = null!;  // Candidate-downloader handler
    private ExtractRecipeFromUrlJob _job = null!;
    private FakeTimeProvider _clock = null!;
    private ImportProgressTokenService _progressTokens = null!;
    private FakePhotoStorage _photoStorage = null!;
    private StubExtractorConfigReader _configReader = null!;

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
        _groupId = group.Id;

        _handler = new StubHttpMessageHandler();
        _thumbnailHandler = new StubHttpMessageHandler();
        var factory = new StubHttpClientFactory(_handler, new Uri("http://python/"));
        // COVER-0 — candidate-downloader replaces the BUG-018 thumbnail
        // client. Point the named handler at the dedicated
        // _thumbnailHandler so candidate-GETs stay isolated from the
        // Python POSTs handler.
        factory.RegisterNamedHandler(CandidateAttacher.HttpClientName, _thumbnailHandler);

        _clock = new FakeTimeProvider(new DateTimeOffset(2026, 4, 18, 12, 0, 0, TimeSpan.Zero));
        var extractorOpts = Options.Create(new ExtractorOptions { SharedSecret = "test-secret" });
        var signer = new ExtractorHmacSigner(extractorOpts, _clock);
        _progressTokens = new ImportProgressTokenService(extractorOpts);
        var runner = new PythonExtractorRunner(
            _db, factory, signer, _progressTokens, new NullLiveSyncPublisher(), _clock,
            NullLogger<PythonExtractorRunner>.Instance);
        _photoStorage = new FakePhotoStorage();
        // BUG-047 — tests run without real DNS. Stub the resolver to
        // return a deterministic public IP so the SSRF guard doesn't
        // reject the video-CDN or blog-same-origin hosts. The rejection
        // path is covered by a dedicated test that wires a private-IP
        // resolver.
        CandidateHostResolver publicResolver = (_, _) =>
            Task.FromResult(new[] { System.Net.IPAddress.Parse("93.184.216.34") });
        // CFG-3 — feature-flag reader. Default behaviour is "flag on"
        // (row missing → fallback true), which keeps every pre-CFG-3
        // test green without touching assertions. Tests that need the
        // kill-switch path construct the attacher themselves with a
        // reader pre-set to false.
        _configReader = new StubExtractorConfigReader();
        var candidateAttacher = new CandidateAttacher(
            _db, factory, _photoStorage, _clock,
            NullLogger<CandidateAttacher>.Instance,
            _configReader,
            publicResolver);
        _job = new ExtractRecipeFromUrlJob(
            _db, runner, candidateAttacher, _photoStorage, _clock,
            NullLogger<ExtractRecipeFromUrlJob>.Instance);
    }

    public async Task DisposeAsync()
    {
        await _db.DisposeAsync();
        await _connection.DisposeAsync();
    }

    private async Task<RecipeImport> SeedImportAsync(string url = "https://example.com/rezept")
    {
        var import = new RecipeImport(_userId, _groupId, ImportSource.Url, url, _clock.GetUtcNow());
        _db.RecipeImports.Add(import);
        await _db.SaveChangesAsync();
        return import;
    }

    private async Task<RecipeImport> SeedImportWithLanguageAsync(string requestedLanguage)
    {
        var import = new RecipeImport(
            _userId,
            _groupId,
            ImportSource.Url,
            "https://example.com/rezept",
            _clock.GetUtcNow(),
            requestedLanguage: requestedLanguage);
        _db.RecipeImports.Add(import);
        await _db.SaveChangesAsync();
        return import;
    }

    [Fact]
    public async Task Happy_Path_Marks_Done_With_Result_Json()
    {
        var import = await SeedImportAsync();
        var recipe = "{\"title\":\"Spätzle\",\"servings\":4}";
        _handler.QueueResponse(HttpStatusCode.OK, recipe);

        await _job.ExecuteAsync(import.Id, CancellationToken.None);

        var reloaded = await _db.RecipeImports.AsNoTracking()
            .SingleAsync(i => i.Id == import.Id);
        Assert.Equal(ImportStatus.Done, reloaded.Status);
        Assert.Equal(100, reloaded.Progress);
        Assert.Equal(recipe, reloaded.ResultJson);
        Assert.Null(reloaded.ErrorMessage);
        Assert.NotNull(reloaded.CompletedAt);
        // No usage headers in the stubbed response → columns stay null.
        Assert.Null(reloaded.PromptTokens);
        Assert.Null(reloaded.ModelDeployment);
    }

    [Fact]
    public async Task Happy_Path_Persists_Token_Usage_From_Headers()
    {
        var import = await SeedImportAsync();
        _handler.QueueResponseWithUsage(
            HttpStatusCode.OK,
            "{\"title\":\"Spätzle\"}",
            promptTokens: 1500,
            completionTokens: 400,
            cachedPromptTokens: 800,
            model: "gpt-5.1-chat");

        await _job.ExecuteAsync(import.Id, CancellationToken.None);

        var reloaded = await _db.RecipeImports.AsNoTracking()
            .SingleAsync(i => i.Id == import.Id);
        Assert.Equal(ImportStatus.Done, reloaded.Status);
        Assert.Equal(1500, reloaded.PromptTokens);
        Assert.Equal(400, reloaded.CompletionTokens);
        Assert.Equal(800, reloaded.CachedPromptTokens);
        Assert.Equal("gpt-5.1-chat", reloaded.ModelDeployment);
    }

    [Fact]
    public async Task Happy_Path_Without_Usage_Headers_Leaves_Columns_Null()
    {
        // A response that's missing the prompt-tokens header (e.g. an
        // older Python build, or a mock provider) must not fail the
        // extraction — the telemetry is "best effort, skip if absent".
        var import = await SeedImportAsync();
        _handler.QueueResponse(HttpStatusCode.OK, "{\"title\":\"x\"}");

        await _job.ExecuteAsync(import.Id, CancellationToken.None);

        var reloaded = await _db.RecipeImports.AsNoTracking()
            .SingleAsync(i => i.Id == import.Id);
        Assert.Equal(ImportStatus.Done, reloaded.Status);
        Assert.Null(reloaded.PromptTokens);
        Assert.Null(reloaded.CompletionTokens);
        Assert.Null(reloaded.CachedPromptTokens);
        Assert.Null(reloaded.ModelDeployment);
    }

    [Fact]
    public async Task Happy_Path_Sends_HMAC_Headers_And_POSTs_Extract_Url()
    {
        var import = await SeedImportAsync();
        _handler.QueueResponse(HttpStatusCode.OK, "{\"title\":\"Spätzle\"}");

        await _job.ExecuteAsync(import.Id, CancellationToken.None);

        var req = Assert.Single(_handler.Requests);
        Assert.Equal(HttpMethod.Post, req.Method);
        Assert.Equal("http://python/extract/url", req.Uri.ToString());
        Assert.True(req.Headers.ContainsKey(ExtractorHmacSigner.SignatureHeader));
        Assert.True(req.Headers.ContainsKey(ExtractorHmacSigner.TimestampHeader));
        Assert.Equal(_userId.ToString("D"), req.Headers[ExtractorHmacSigner.UserIdHeader]);
        Assert.Contains("\"url\":\"https://example.com/rezept\"", req.Body);
        Assert.Contains("\"hint\":", req.Body);
    }

    [Fact]
    public async Task Python_400_Marks_Error_And_Throws_Terminal()
    {
        var import = await SeedImportAsync();
        _handler.QueueResponse(
            HttpStatusCode.BadRequest,
            "{\"detail\":\"Video nicht erreichbar.\"}");

        var ex = await Assert.ThrowsAsync<PythonExtractorException>(
            () => _job.ExecuteAsync(import.Id, CancellationToken.None));

        Assert.True(ex.IsTerminal);
        Assert.Equal(400, ex.StatusCode);

        var reloaded = await _db.RecipeImports.AsNoTracking()
            .SingleAsync(i => i.Id == import.Id);
        Assert.Equal(ImportStatus.Error, reloaded.Status);
        Assert.Equal("Video nicht erreichbar.", reloaded.ErrorMessage);
        Assert.Null(reloaded.ResultJson);
    }

    [Fact]
    public async Task Python_422_Treated_As_Terminal()
    {
        var import = await SeedImportAsync();
        _handler.QueueResponse(
            HttpStatusCode.UnprocessableEntity,
            "{\"detail\":\"Kein Rezept im Quelltext erkannt.\"}");

        var ex = await Assert.ThrowsAsync<PythonExtractorException>(
            () => _job.ExecuteAsync(import.Id, CancellationToken.None));

        Assert.True(ex.IsTerminal);

        var reloaded = await _db.RecipeImports.AsNoTracking()
            .SingleAsync(i => i.Id == import.Id);
        Assert.Equal(ImportStatus.Error, reloaded.Status);
    }

    [Fact]
    public async Task Python_503_Is_Non_Terminal_And_Leaves_Status_Running()
    {
        var import = await SeedImportAsync();
        _handler.QueueResponse(
            HttpStatusCode.ServiceUnavailable,
            "{\"detail\":\"KI-Service momentan nicht erreichbar.\"}");

        var ex = await Assert.ThrowsAsync<PythonExtractorException>(
            () => _job.ExecuteAsync(import.Id, CancellationToken.None));

        Assert.False(ex.IsTerminal);
        Assert.Equal(503, ex.StatusCode);

        var reloaded = await _db.RecipeImports.AsNoTracking()
            .SingleAsync(i => i.Id == import.Id);
        // Non-terminal = left in Running so Hangfire's retry can pick up.
        Assert.Equal(ImportStatus.Running, reloaded.Status);
        Assert.Null(reloaded.ErrorMessage);
    }

    [Fact]
    public async Task Retry_After_503_Can_Succeed()
    {
        var import = await SeedImportAsync();
        _handler.QueueResponse(HttpStatusCode.ServiceUnavailable, "{\"detail\":\"try later\"}");
        _handler.QueueResponse(HttpStatusCode.OK, "{\"title\":\"Retry\"}");

        // First attempt — transient failure.
        await Assert.ThrowsAsync<PythonExtractorException>(
            () => _job.ExecuteAsync(import.Id, CancellationToken.None));

        // Second attempt — succeeds. Row moves from Running → Done.
        await _job.ExecuteAsync(import.Id, CancellationToken.None);

        var reloaded = await _db.RecipeImports.AsNoTracking()
            .SingleAsync(i => i.Id == import.Id);
        Assert.Equal(ImportStatus.Done, reloaded.Status);
        Assert.Equal("{\"title\":\"Retry\"}", reloaded.ResultJson);
        Assert.Equal(2, _handler.Requests.Count);
    }

    [Fact]
    public async Task Transport_Failure_Throws_Non_Terminal()
    {
        var import = await SeedImportAsync();
        _handler.QueueResponder(_ => throw new HttpRequestException("connection refused"));

        var ex = await Assert.ThrowsAsync<PythonExtractorException>(
            () => _job.ExecuteAsync(import.Id, CancellationToken.None));

        Assert.False(ex.IsTerminal);
        Assert.Null(ex.StatusCode);
    }

    [Fact]
    public async Task Malformed_JSON_Body_Is_Non_Terminal()
    {
        var import = await SeedImportAsync();
        _handler.QueueResponse(HttpStatusCode.OK, "not-json");

        var ex = await Assert.ThrowsAsync<PythonExtractorException>(
            () => _job.ExecuteAsync(import.Id, CancellationToken.None));

        Assert.False(ex.IsTerminal);
        Assert.Equal(502, ex.StatusCode);
    }

    [Fact]
    public async Task Mismatched_Source_Rejects()
    {
        // Seed a Photos import and try to run the URL job on it.
        var import = new RecipeImport(
            _userId, _groupId, ImportSource.Photos, sourceUrl: null, _clock.GetUtcNow());
        _db.RecipeImports.Add(import);
        await _db.SaveChangesAsync();

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => _job.ExecuteAsync(import.Id, CancellationToken.None));

        Assert.Empty(_handler.Requests);
    }

    // ── PV2 hotfix regression tests ─────────────────────────────────
    //
    // The original PV1/PV2 shipped backend + Python reporter but the
    // .NET → Python /extract/url body never carried callback_url,
    // callback_token, import_id or attempt. Python fell back to
    // NullProgressReporter → UI stuck at Queued(5%) for the full
    // 1-3 min extraction. These tests assert all four fields show up
    // on the outbound JSON body so the silent regression can't recur.

    [Fact]
    public async Task Outbound_Body_Carries_Progress_Callback_Fields()
    {
        var import = await SeedImportAsync();
        _handler.QueueResponse(HttpStatusCode.OK, "{\"title\":\"x\"}");

        await _job.ExecuteAsync(import.Id, CancellationToken.None);

        var req = Assert.Single(_handler.Requests);
        Assert.NotNull(req.Body);
        using var doc = JsonDocument.Parse(req.Body!);
        var root = doc.RootElement;

        // callback_url uses the default docker hostname when env var unset.
        var callbackUrl = root.GetProperty("callback_url").GetString();
        Assert.Equal(
            $"http://api:5000/api/internal/imports/{import.Id:D}/progress",
            callbackUrl);

        // callback_token — must validate via the same signer.
        var token = root.GetProperty("callback_token").GetString();
        Assert.False(string.IsNullOrEmpty(token));
        var verified = _progressTokens.TryVerify(
            token, import.Id, _clock.GetUtcNow(), out var failure);
        Assert.True(verified, $"token failed: {failure}");

        // import_id is the canonical dashed GUID.
        Assert.Equal(import.Id.ToString("D"), root.GetProperty("import_id").GetString());

        // attempt mirrors the domain entity (starts at 1).
        Assert.Equal(import.AttemptNumber, root.GetProperty("attempt").GetInt32());
        Assert.Equal(1, root.GetProperty("attempt").GetInt32());

        // The original url + hint payload survives the merge.
        Assert.Equal("https://example.com/rezept", root.GetProperty("url").GetString());
        Assert.Equal(JsonValueKind.Object, root.GetProperty("hint").ValueKind);
    }

    [Fact]
    public async Task Callback_Base_Url_Honours_Env_Override()
    {
        var original = Environment.GetEnvironmentVariable(PythonExtractorRunner.CallbackBaseUrlEnvVar);
        Environment.SetEnvironmentVariable(
            PythonExtractorRunner.CallbackBaseUrlEnvVar,
            "http://api-host.test:9999/");
        try
        {
            var import = await SeedImportAsync();
            _handler.QueueResponse(HttpStatusCode.OK, "{\"title\":\"x\"}");

            await _job.ExecuteAsync(import.Id, CancellationToken.None);

            var req = Assert.Single(_handler.Requests);
            using var doc = JsonDocument.Parse(req.Body!);
            Assert.Equal(
                $"http://api-host.test:9999/api/internal/imports/{import.Id:D}/progress",
                doc.RootElement.GetProperty("callback_url").GetString());
        }
        finally
        {
            Environment.SetEnvironmentVariable(
                PythonExtractorRunner.CallbackBaseUrlEnvVar, original);
        }
    }

    [Fact]
    public async Task Outbound_Attempt_Reflects_Retry_Bump()
    {
        // Simulate a crashed first attempt: row sits in Running/Downloading
        // when the job re-enters. The runner bumps AttemptNumber to 2
        // before dispatch, so the outbound body must carry attempt=2.
        var import = await SeedImportAsync();
        import.MarkRunning(10);
        import.UpdateProgress(
            phase: RecipeImportPhase.Downloading,
            phaseProgress: 0, bytesDownloaded: null, bytesTotal: null,
            segmentsDone: null, segmentsTotal: null,
            attempt: import.AttemptNumber, now: _clock.GetUtcNow());
        await _db.SaveChangesAsync();

        _handler.QueueResponse(HttpStatusCode.OK, "{\"title\":\"Retry\"}");

        await _job.ExecuteAsync(import.Id, CancellationToken.None);

        var req = Assert.Single(_handler.Requests);
        using var doc = JsonDocument.Parse(req.Body!);
        Assert.Equal(2, doc.RootElement.GetProperty("attempt").GetInt32());
        // Token still verifies for the (now-running) importId.
        var token = doc.RootElement.GetProperty("callback_token").GetString();
        Assert.True(_progressTokens.TryVerify(
            token, import.Id, _clock.GetUtcNow(), out _));
    }

    // ── BUG-018: Auto-attach video thumbnail as staged recipe photo ──
    //
    // After the URL extraction completes successfully and the result
    // carries a `recipe.candidate_thumbnails` array, the job downloads
    // each URL, uploads it to SeaweedFS, persists a StagedPhoto row per
    // candidate, and surfaces the ordered ids via
    // RecipeImport.CandidateStagedPhotoIds. Failures of individual
    // candidates never surface — the recipe creation must always
    // succeed.

    /// <summary>Result JSON the Python pipeline would emit, with a
    /// single-element <c>candidate_thumbnails</c> array on an allowed
    /// FB-CDN host.</summary>
    private const string ResultWithFbcdnThumbnail = """
        {
          "recipe": {
            "title": "Pizza",
            "candidate_thumbnails": ["https://scontent-fra3-2.xx.fbcdn.net/v/thumb.jpg"]
          },
          "confidence": { "overall": "high", "notes": [] }
        }
        """;

    private static byte[] FakePngBytes()
    {
        // Minimal PNG header — the attacher only checks the response
        // content-type, not the bytes themselves, so any non-empty
        // buffer round-trips through the fake storage.
        return new byte[]
        {
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
            0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
        };
    }

    [Fact]
    public async Task BUG018_Thumbnail_Downloaded_And_Linked_To_Import()
    {
        var import = await SeedImportAsync();
        _handler.QueueResponse(HttpStatusCode.OK, ResultWithFbcdnThumbnail);
        var bytes = FakePngBytes();
        _thumbnailHandler.QueueBytesResponse(HttpStatusCode.OK, bytes, "image/png");

        await _job.ExecuteAsync(import.Id, CancellationToken.None);

        var reloaded = await _db.RecipeImports.AsNoTracking()
            .SingleAsync(i => i.Id == import.Id);
        Assert.Equal(ImportStatus.Done, reloaded.Status);
        // COVER-0 — single candidate staged with default-cover order 0.
        Assert.Single(reloaded.CandidateStagedPhotoIds);

        // StagedPhoto row was actually persisted with the same id, owned
        // by the same user, with the upload's bytes mirrored into storage.
        var staged = await _db.StagedPhotos.AsNoTracking()
            .SingleAsync(s => s.Id == reloaded.CandidateStagedPhotoIds[0]);
        Assert.Equal(_userId, staged.UserId);
        Assert.Equal("image/png", staged.ContentType);
        Assert.Equal(import.Id, staged.LinkedImportId);
        Assert.Equal(0, staged.CandidateOrder);
        Assert.True(_photoStorage.Uploads.ContainsKey(staged.PhotoId));
        Assert.Equal(bytes, _photoStorage.Uploads[staged.PhotoId].Content);

        // Sanity — the candidate GET hit the CDN URL exactly once.
        var thumbReq = Assert.Single(_thumbnailHandler.Requests);
        Assert.Equal(HttpMethod.Get, thumbReq.Method);
        Assert.Equal(
            "https://scontent-fra3-2.xx.fbcdn.net/v/thumb.jpg",
            thumbReq.Uri.ToString());
    }

    [Fact]
    public async Task BUG018_Cdn_500_Leaves_Thumbnail_Null_But_Import_Succeeds()
    {
        // The CDN is misbehaving — graceful skip, recipe still ships.
        var import = await SeedImportAsync();
        _handler.QueueResponse(HttpStatusCode.OK, ResultWithFbcdnThumbnail);
        _thumbnailHandler.QueueBytesResponse(
            HttpStatusCode.InternalServerError, Array.Empty<byte>(), "text/plain");

        await _job.ExecuteAsync(import.Id, CancellationToken.None);

        var reloaded = await _db.RecipeImports.AsNoTracking()
            .SingleAsync(i => i.Id == import.Id);
        Assert.Equal(ImportStatus.Done, reloaded.Status);
        Assert.Empty(reloaded.CandidateStagedPhotoIds);
        // No StagedPhoto row was created on the failure path.
        Assert.Empty(await _db.StagedPhotos.AsNoTracking().ToListAsync());
        // No blob landed in storage either.
        Assert.Empty(_photoStorage.Uploads);
    }

    [Fact]
    public async Task BUG018_Oversize_ContentLength_Skips_Download()
    {
        // Declared Content-Length above the 5 MB cap → bail before
        // streaming, so the response body never reaches storage.
        var import = await SeedImportAsync();
        _handler.QueueResponse(HttpStatusCode.OK, ResultWithFbcdnThumbnail);
        _thumbnailHandler.QueueBytesResponse(
            HttpStatusCode.OK,
            FakePngBytes(),
            "image/png",
            declaredContentLength: CandidateAttacher.MaxBytesPerCandidate + 1);

        await _job.ExecuteAsync(import.Id, CancellationToken.None);

        var reloaded = await _db.RecipeImports.AsNoTracking()
            .SingleAsync(i => i.Id == import.Id);
        Assert.Equal(ImportStatus.Done, reloaded.Status);
        Assert.Empty(reloaded.CandidateStagedPhotoIds);
        Assert.Empty(_photoStorage.Uploads);
    }

    [Fact]
    public async Task BUG018_Non_Image_ContentType_Skips_Download()
    {
        // CDN handed back HTML (e.g. an error page redirect) instead of
        // an image. Graceful skip, no row, no blob, recipe still done.
        var import = await SeedImportAsync();
        _handler.QueueResponse(HttpStatusCode.OK, ResultWithFbcdnThumbnail);
        _thumbnailHandler.QueueBytesResponse(
            HttpStatusCode.OK,
            FakePngBytes(),
            "text/html");

        await _job.ExecuteAsync(import.Id, CancellationToken.None);

        var reloaded = await _db.RecipeImports.AsNoTracking()
            .SingleAsync(i => i.Id == import.Id);
        Assert.Equal(ImportStatus.Done, reloaded.Status);
        Assert.Empty(reloaded.CandidateStagedPhotoIds);
        Assert.Empty(_photoStorage.Uploads);
    }

    [Fact]
    public async Task BUG018_Result_Without_Thumbnail_Url_Skips_Download_Entirely()
    {
        // Empty candidate_thumbnails → no CDN GET, no storage write,
        // CandidateStagedPhotoIds stays empty. This is the common blog-
        // import path when JSON-LD has no image entries at all AND the
        // blog has no og:image for the extractor's single-URL fallback
        // to seed from.
        var import = await SeedImportAsync();
        _handler.QueueResponse(
            HttpStatusCode.OK,
            "{\"recipe\": {\"title\": \"Blog Pizza\", \"candidate_thumbnails\": []}, \"confidence\": {\"overall\": \"high\", \"notes\": []}}");

        await _job.ExecuteAsync(import.Id, CancellationToken.None);

        var reloaded = await _db.RecipeImports.AsNoTracking()
            .SingleAsync(i => i.Id == import.Id);
        Assert.Equal(ImportStatus.Done, reloaded.Status);
        Assert.Empty(reloaded.CandidateStagedPhotoIds);
        Assert.Empty(_thumbnailHandler.Requests);
        Assert.Empty(_photoStorage.Uploads);
    }

    [Fact]
    public async Task BUG018_Disallowed_Host_Rejects_Without_Network_Hit()
    {
        // SSRF guard: a candidate URL pointing at a host outside the
        // CDN allowlist (e.g. an attacker plant pointing at an internal
        // service) must be rejected *before* any HTTP call is made.
        var import = await SeedImportAsync();
        _handler.QueueResponse(
            HttpStatusCode.OK,
            """
            {
              "recipe": {
                "title": "Evil",
                "candidate_thumbnails": ["http://169.254.169.254/latest/meta-data/iam/security-credentials/"]
              },
              "confidence": { "overall": "high", "notes": [] }
            }
            """);

        await _job.ExecuteAsync(import.Id, CancellationToken.None);

        var reloaded = await _db.RecipeImports.AsNoTracking()
            .SingleAsync(i => i.Id == import.Id);
        Assert.Equal(ImportStatus.Done, reloaded.Status);
        Assert.Empty(reloaded.CandidateStagedPhotoIds);
        // The candidate handler must not have been touched at all.
        Assert.Empty(_thumbnailHandler.Requests);
    }

    [Theory]
    [InlineData("https://scontent-fra3-2.xx.fbcdn.net/v/thumb.jpg", true)]
    [InlineData("https://i.ytimg.com/vi/abc/hqdefault.jpg", true)]
    [InlineData("https://scontent.cdninstagram.com/v/foo.jpg", true)]
    [InlineData("https://p16-sign-va.tiktokcdn.com/v/x.jpeg", true)]
    [InlineData("http://internal/secret", false)]
    [InlineData("https://evilfbcdn.net/x.jpg", false)] // no leading dot anchor
    [InlineData("file:///etc/passwd", false)]
    [InlineData("ftp://cdn/x", false)]
    [InlineData("", false)]
    public void BUG018_Host_Allowlist_Suffix_Match(string url, bool allowed)
    {
        // CDN allowlist behaviour is exposed via the same
        // same-origin-aware helper with a null sourceUrl — the CDN
        // branch fires first and is independent of SourceUrl.
        Assert.Equal(allowed,
            CandidateAttacher.IsAllowedHostForImport(url, sourceUrl: null, out _));
    }

    // ── BUG-047: accept blog-hosted thumbnails when they live on the
    // same registered domain (eTLD+1) as the import's SourceUrl. The
    // video-CDN allowlist stays authoritative; this is an additive rule.
    //
    // Rationale: the Python extractor already SSRF-checked and fetched
    // the SourceUrl. A blog's own og:image on the same registered
    // domain inherits that trust. Cross-origin thumbnails (attacker
    // controls the recipe URL → points image at someone else's host)
    // remain rejected.

    /// <summary>Result JSON emitting a candidate_thumbnails array of
    /// one URL on the blog's own host (masonfit.com). Mirrors the shape
    /// the Python extractor returns for BUG-047's reproducer URL.</summary>
    private const string ResultWithMasonfitThumbnail = """
        {
          "recipe": {
            "title": "Hoisin Beef Noodles",
            "candidate_thumbnails": ["https://masonfit.com/wp-content/uploads/hero.jpg"]
          },
          "confidence": { "overall": "high", "notes": [] }
        }
        """;

    [Fact]
    public async Task BUG047_Blog_Same_Origin_Thumbnail_Is_Accepted()
    {
        // SourceUrl on masonfit.com + thumbnail on masonfit.com →
        // same registered domain → download + stage succeeds.
        var import = await SeedImportAsync("https://masonfit.com/hoisin-beef-noodles/");
        _handler.QueueResponse(HttpStatusCode.OK, ResultWithMasonfitThumbnail);
        var bytes = FakePngBytes();
        _thumbnailHandler.QueueBytesResponse(HttpStatusCode.OK, bytes, "image/jpeg");

        await _job.ExecuteAsync(import.Id, CancellationToken.None);

        var reloaded = await _db.RecipeImports.AsNoTracking()
            .SingleAsync(i => i.Id == import.Id);
        Assert.Equal(ImportStatus.Done, reloaded.Status);
        Assert.Single(reloaded.CandidateStagedPhotoIds);

        var staged = await _db.StagedPhotos.AsNoTracking()
            .SingleAsync(s => s.Id == reloaded.CandidateStagedPhotoIds[0]);
        Assert.Equal(_userId, staged.UserId);
        Assert.Equal("image/jpeg", staged.ContentType);
    }

    [Fact]
    public async Task BUG047_Blog_Sibling_Subdomain_Thumbnail_Is_Accepted()
    {
        // SourceUrl on www.blog.com + thumbnail on cdn.blog.com →
        // shared eTLD+1 (blog.com) → accepted. Blogs commonly serve
        // their own images off a sibling CDN subdomain.
        var import = await SeedImportAsync("https://www.blog.com/recipe");
        const string resultJson = """
            {
              "recipe": {
                "title": "Blog Recipe",
                "candidate_thumbnails": ["https://cdn.blog.com/img/hero.jpg"]
              },
              "confidence": { "overall": "high", "notes": [] }
            }
            """;
        _handler.QueueResponse(HttpStatusCode.OK, resultJson);
        _thumbnailHandler.QueueBytesResponse(
            HttpStatusCode.OK, FakePngBytes(), "image/png");

        await _job.ExecuteAsync(import.Id, CancellationToken.None);

        var reloaded = await _db.RecipeImports.AsNoTracking()
            .SingleAsync(i => i.Id == import.Id);
        Assert.Equal(ImportStatus.Done, reloaded.Status);
        Assert.Single(reloaded.CandidateStagedPhotoIds);
    }

    [Fact]
    public async Task BUG047_Cross_Origin_Thumbnail_Is_Rejected()
    {
        // SourceUrl on masonfit.com but thumbnail on evil.example →
        // different registered domain, not on the video-CDN allowlist →
        // rejected. No HTTP call to the thumbnail host.
        var import = await SeedImportAsync("https://masonfit.com/hoisin-beef-noodles/");
        const string resultJson = """
            {
              "recipe": {
                "title": "Pwned",
                "candidate_thumbnails": ["https://evil.example/x.jpg"]
              },
              "confidence": { "overall": "high", "notes": [] }
            }
            """;
        _handler.QueueResponse(HttpStatusCode.OK, resultJson);

        await _job.ExecuteAsync(import.Id, CancellationToken.None);

        var reloaded = await _db.RecipeImports.AsNoTracking()
            .SingleAsync(i => i.Id == import.Id);
        Assert.Equal(ImportStatus.Done, reloaded.Status);
        Assert.Empty(reloaded.CandidateStagedPhotoIds);
        Assert.Empty(_thumbnailHandler.Requests);
    }

    [Fact]
    public async Task BUG047_Private_Ip_Resolution_Rejects_Same_Origin_Thumbnail()
    {
        // SSRF defence-in-depth: a hostile blog can own evil.com (A
        // record → public IP so the Python extractor fetches the page)
        // but point "internal.evil.com" at 192.168.1.1 or 169.254.169.254
        // (AWS metadata). The registered-domain check would accept the
        // host; the DNS public-IP guard rejects it.
        //
        // Rebuild the attacher with a resolver that returns a private
        // IP, so the guard fires.
        var factory = new StubHttpClientFactory(_handler, new Uri("http://python/"));
        factory.RegisterNamedHandler(CandidateAttacher.HttpClientName, _thumbnailHandler);
        CandidateHostResolver privateResolver = (_, _) =>
            Task.FromResult(new[] { System.Net.IPAddress.Parse("192.168.1.1") });
        var attacher = new CandidateAttacher(
            _db, factory, _photoStorage, _clock,
            NullLogger<CandidateAttacher>.Instance,
            _configReader,
            privateResolver);
        var job = new ExtractRecipeFromUrlJob(_db, new PythonExtractorRunner(
            _db, factory,
            new ExtractorHmacSigner(
                Options.Create(new ExtractorOptions { SharedSecret = "test-secret" }),
                _clock),
            _progressTokens, new NullLiveSyncPublisher(), _clock,
            NullLogger<PythonExtractorRunner>.Instance), attacher, _photoStorage, _clock,
            NullLogger<ExtractRecipeFromUrlJob>.Instance);

        var import = await SeedImportAsync("https://evil.com/recipe");
        _handler.QueueResponse(HttpStatusCode.OK, """
            {
              "recipe": {
                "title": "SSRF",
                "candidate_thumbnails": ["https://internal.evil.com/admin.jpg"]
              },
              "confidence": { "overall": "high", "notes": [] }
            }
            """);

        await job.ExecuteAsync(import.Id, CancellationToken.None);

        var reloaded = await _db.RecipeImports.AsNoTracking()
            .SingleAsync(i => i.Id == import.Id);
        Assert.Equal(ImportStatus.Done, reloaded.Status);
        Assert.Empty(reloaded.CandidateStagedPhotoIds);
        // No HTTP GET against the internal host.
        Assert.Empty(_thumbnailHandler.Requests);
    }

    [Theory]
    [InlineData("10.0.0.1", false)]
    [InlineData("10.255.255.255", false)]
    [InlineData("172.16.0.1", false)]
    [InlineData("172.31.255.255", false)]
    [InlineData("172.32.0.1", true)] // outside 172.16/12 range
    [InlineData("192.168.0.1", false)]
    [InlineData("127.0.0.1", false)]
    [InlineData("169.254.169.254", false)] // AWS metadata
    [InlineData("0.0.0.0", false)]
    [InlineData("100.64.0.1", false)] // CGNAT
    [InlineData("224.0.0.1", false)] // multicast
    [InlineData("255.255.255.255", false)] // broadcast
    [InlineData("8.8.8.8", true)]
    [InlineData("93.184.216.34", true)]
    [InlineData("::1", false)] // IPv6 loopback
    [InlineData("fe80::1", false)] // IPv6 link-local
    [InlineData("fc00::1", false)] // IPv6 unique-local
    [InlineData("fd00::1", false)] // IPv6 unique-local
    [InlineData("::ffff:192.168.1.1", false)] // IPv4-mapped private
    [InlineData("2001:4860:4860::8888", true)] // Google DNS v6
    public void BUG047_Public_Address_Predicate(string ip, bool expected)
    {
        var addr = System.Net.IPAddress.Parse(ip);
        Assert.Equal(expected, CandidateAttacher.IsPublicAddress(addr));
    }

    [Theory]
    // Null sourceHost → only the video-CDN allowlist applies. An
    // import with no trusted SourceUrl (e.g. a photo-import retry
    // re-entering the URL path) must NOT unlock arbitrary hosts.
    [InlineData("https://random.example/x.jpg", null, false)]
    // Same registered domain (eTLD+1 approximation via leftmost-label
    // strip) → accepted even when not on the CDN allowlist.
    [InlineData("https://masonfit.com/wp/img.jpg", "https://masonfit.com/hoisin-beef-noodles/", true)]
    [InlineData("https://cdn.blog.com/hero.jpg", "https://www.blog.com/recipe", true)]
    // Cross-origin — different registered domains → rejected.
    [InlineData("https://evil.example/x.jpg", "https://masonfit.com/recipe", false)]
    // Two-label hosts without a shared second label → rejected.
    [InlineData("https://evilblog.com/x.jpg", "https://blog.com/recipe", false)]
    // Video-CDN allowlist still wins regardless of SourceUrl.
    [InlineData("https://scontent.xx.fbcdn.net/v/x.jpg", null, true)]
    [InlineData("https://scontent.xx.fbcdn.net/v/x.jpg", "https://masonfit.com/r", true)]
    public void BUG047_Host_Acceptance_With_Source_Url(
        string thumbnailUrl, string? sourceUrl, bool expected)
    {
        Assert.Equal(expected,
            CandidateAttacher.IsAllowedHostForImport(
                thumbnailUrl, sourceUrl, out _));
    }

    // ── REIMPORT-0: in-place update on a pre-existing recipe ───────
    //
    // When the import row carries a non-null TargetRecipeId, the job
    // must (a) load the target recipe, (b) let the Python pipeline
    // produce a fresh extraction result the same way as a new import,
    // (c) overwrite the recipe's mutable body via UpdateFromImport
    // rather than letting the PF1 promote-flow insert a new row, and
    // (d) dedupe auto-attached thumbnails by URL so a reimport doesn't
    // pile duplicate photos onto the recipe.

    private async Task<Recipe> SeedTargetRecipeAsync(
        string? sourceUrl = "https://example.com/rezept",
        string title = "Altes Rezept")
    {
        var recipe = new Recipe(
            groupId: _groupId,
            createdByUserId: _userId,
            title: title,
            description: "Alte Beschreibung",
            defaultServings: 2,
            prepTimeMinutes: 5,
            difficulty: 1,
            sourceUrl: sourceUrl,
            sourceType: RecipeSourceType.Video,
            forkOfRecipeId: null,
            createdAt: _clock.GetUtcNow());
        _db.Recipes.Add(recipe);
        await _db.SaveChangesAsync();
        return recipe;
    }

    private async Task<RecipeImport> SeedReimportAsync(Recipe target)
    {
        var import = new RecipeImport(
            _userId, _groupId, ImportSource.Url,
            sourceUrl: target.SourceUrl,
            createdAt: _clock.GetUtcNow(),
            targetRecipeId: target.Id);
        _db.RecipeImports.Add(import);
        await _db.SaveChangesAsync();
        return import;
    }

    /// <summary>Result JSON the Python pipeline emits for a reimport
    /// smoke — minimal shape covering title + one ingredient + one step
    /// + one tag (seeded globally below so the domain's AI-tag resolver
    /// finds a match).</summary>
    private const string ReimportResult = """
        {
          "recipe": {
            "title": "Neues Rezept",
            "description": "Frisch extrahiert",
            "servings": 4,
            "difficulty": 2,
            "prep_minutes": 15,
            "cook_minutes": null,
            "components": [
              {
                "position": 0,
                "label": null,
                "ingredients": [
                  { "name": "Mehl", "quantity": "500", "unit": "g", "note": null, "confidence": "high" }
                ],
                "steps": [
                  { "position": 1, "content": "Vermengen.", "confidence": "high" }
                ]
              }
            ],
            "tags": ["schnell"],
            "source_url": "https://example.com/rezept"
          },
          "confidence": { "overall": "high", "notes": [] },
          "recipe_empty": false,
          "empty_reason": null
        }
        """;

    [Fact]
    public async Task REIMPORT_Updates_Target_Recipe_In_Place_And_Bumps_Version()
    {
        // Seed the global AI tag so UpdateFromImport's name resolver
        // finds "schnell" and preserves the AI side of the Tag merge.
        _db.Tags.Add(Tag.CreateGlobal("schnell", TagCategory.Aufwand));
        await _db.SaveChangesAsync();

        var target = await SeedTargetRecipeAsync();
        var originalId = target.Id;
        var originalCreated = target.CreatedAt;
        var originalCreator = target.CreatedByUserId;
        var versionBefore = target.Version;

        var import = await SeedReimportAsync(target);
        _handler.QueueResponse(HttpStatusCode.OK, ReimportResult);

        await _job.ExecuteAsync(import.Id, CancellationToken.None);

        using var freshDb = new AppDbContext(
            new DbContextOptionsBuilder<AppDbContext>().UseSqlite(_connection).Options);
        var reloaded = await freshDb.Recipes
            .Include(r => r.Ingredients)
            .Include(r => r.Steps)
            .Include(r => r.RecipeTags)
            .SingleAsync(r => r.Id == originalId);

        // Recipe row was updated IN PLACE — same id / group / creator /
        // createdAt, bumped version, new body.
        Assert.Equal(originalId, reloaded.Id);
        Assert.Equal(originalCreator, reloaded.CreatedByUserId);
        Assert.Equal(originalCreated, reloaded.CreatedAt);
        Assert.Equal(versionBefore + 1, reloaded.Version);
        Assert.Equal("Neues Rezept", reloaded.Title);
        Assert.Equal("Frisch extrahiert", reloaded.Description);
        Assert.Equal(4, reloaded.DefaultServings);
        Assert.Equal(15, reloaded.PrepTimeMinutes);
        Assert.Equal(2, reloaded.Difficulty);
        Assert.Single(reloaded.Ingredients);
        Assert.Equal("Mehl", reloaded.Ingredients.Single().Name);
        Assert.Single(reloaded.Steps);
        Assert.Equal("Vermengen.", reloaded.Steps.Single().Content);
        // Global "schnell" tag was attached via AI-merge.
        Assert.Single(reloaded.RecipeTags);

        // No NEW recipe row created — reimport is in-place.
        Assert.Equal(1, await freshDb.Recipes.CountAsync(r => r.GroupId == _groupId));

        // Import ends in Done with TargetRecipeId still set for the
        // frontend's redirect path.
        var importReloaded = await freshDb.RecipeImports.AsNoTracking()
            .SingleAsync(i => i.Id == import.Id);
        Assert.Equal(ImportStatus.Done, importReloaded.Status);
        Assert.Equal(originalId, importReloaded.TargetRecipeId);
    }

    /// <summary>Result JSON with a fixed candidate_thumbnails array the
    /// reimport tests share. The URL is on the FB-CDN allowlist so the
    /// SSRF guard accepts it without needing a SourceUrl match.</summary>
    private const string ReimportResultWithThumb = """
        {
          "recipe": {
            "title": "Neu mit Bild",
            "description": null,
            "servings": 2,
            "difficulty": 1,
            "prep_minutes": null,
            "cook_minutes": null,
            "components": [
              { "position": 0, "label": null, "ingredients": [], "steps": [] }
            ],
            "tags": [],
            "source_url": "https://example.com/rezept",
            "candidate_thumbnails": ["https://scontent-fra3-2.xx.fbcdn.net/v/thumb.jpg"]
          },
          "confidence": { "overall": "high", "notes": [] },
          "recipe_empty": false,
          "empty_reason": null
        }
        """;

    /// <summary>
    /// BUG-048 — a reimport with a fresh candidate_thumbnails entry
    /// must promote the downloaded thumbnail onto the target recipe's
    /// Photos. Previously
    /// the attacher only staged the photo + linked it to the import row,
    /// so Recipe.Photos stayed empty and the detail page still showed
    /// the old thumbnail.
    /// </summary>
    [Fact]
    public async Task BUG048_Reimport_Promotes_Fresh_Thumbnail_Onto_Recipe_Photos()
    {
        var target = await SeedTargetRecipeAsync();
        Assert.Empty(target.Photos);

        var import = await SeedReimportAsync(target);
        _handler.QueueResponse(HttpStatusCode.OK, ReimportResultWithThumb);
        _thumbnailHandler.QueueBytesResponse(HttpStatusCode.OK, FakePngBytes(), "image/png");

        await _job.ExecuteAsync(import.Id, CancellationToken.None);

        using var freshDb = new AppDbContext(
            new DbContextOptionsBuilder<AppDbContext>().UseSqlite(_connection).Options);
        var reloaded = await freshDb.Recipes.SingleAsync(r => r.Id == target.Id);

        // The freshly-staged photo was copied into the recipe namespace
        // and appended to Photos — the detail page's first photo is now
        // the new thumbnail rather than whatever the recipe carried
        // before the reimport.
        Assert.Single(reloaded.Photos);
        Assert.StartsWith("recipes/", reloaded.Photos[0]);
        Assert.True(_photoStorage.Uploads.ContainsKey(reloaded.Photos[0]));

        // The StagedPhoto row was promoted (not left orphaned).
        var staged = await freshDb.StagedPhotos.AsNoTracking()
            .SingleAsync(s => s.PromotedToRecipeId == target.Id);
        Assert.NotNull(staged.PromotedAt);
        Assert.Equal(
            "https://scontent-fra3-2.xx.fbcdn.net/v/thumb.jpg",
            staged.SourceUrl);
    }

    /// <summary>
    /// BUG-048 — a second reimport with the same thumbnail URL must NOT
    /// append a duplicate photo to the recipe. The dedupe looks up the
    /// previously-promoted StagedPhoto by (PromotedToRecipeId, SourceUrl)
    /// and short-circuits before any CDN fetch.
    /// </summary>
    [Fact]
    public async Task BUG048_Repeat_Reimport_With_Same_Thumbnail_Url_Does_Not_Duplicate()
    {
        var target = await SeedTargetRecipeAsync();

        // First reimport — promotes the thumbnail.
        var firstImport = await SeedReimportAsync(target);
        _handler.QueueResponse(HttpStatusCode.OK, ReimportResultWithThumb);
        _thumbnailHandler.QueueBytesResponse(HttpStatusCode.OK, FakePngBytes(), "image/png");
        await _job.ExecuteAsync(firstImport.Id, CancellationToken.None);

        var thumbRequestsAfterFirst = _thumbnailHandler.Requests.Count;

        // Second reimport, same URL — must not re-stage, must not
        // duplicate the photo on the recipe.
        var secondImport = await SeedReimportAsync(target);
        _handler.QueueResponse(HttpStatusCode.OK, ReimportResultWithThumb);
        // Intentionally do NOT queue a thumbnail response — the dedupe
        // guard should short-circuit before the HTTP call.
        await _job.ExecuteAsync(secondImport.Id, CancellationToken.None);

        using var freshDb = new AppDbContext(
            new DbContextOptionsBuilder<AppDbContext>().UseSqlite(_connection).Options);
        var reloaded = await freshDb.Recipes.SingleAsync(r => r.Id == target.Id);

        Assert.Single(reloaded.Photos);
        Assert.Equal(thumbRequestsAfterFirst, _thumbnailHandler.Requests.Count);

        // Exactly one promoted staged-photo row — the second reimport
        // neither created nor promoted a new one.
        var promoted = await freshDb.StagedPhotos.AsNoTracking()
            .Where(s => s.PromotedToRecipeId == target.Id)
            .ToListAsync();
        Assert.Single(promoted);
    }

    /// <summary>
    /// BUG-048 — a reimport whose extractor result has no
    /// candidate_thumbnails array (typical for blog-import paths with
    /// no og:image + no JSON-LD image entries) must leave the recipe's
    /// Photos collection completely untouched. No thumbnail download,
    /// no staged-photo row.
    /// </summary>
    [Fact]
    public async Task BUG048_Reimport_With_No_Thumbnail_Url_Leaves_Photos_Untouched()
    {
        var target = await SeedTargetRecipeAsync();
        var import = await SeedReimportAsync(target);
        _handler.QueueResponse(HttpStatusCode.OK, ReimportResult);

        await _job.ExecuteAsync(import.Id, CancellationToken.None);

        using var freshDb = new AppDbContext(
            new DbContextOptionsBuilder<AppDbContext>().UseSqlite(_connection).Options);
        var reloaded = await freshDb.Recipes.SingleAsync(r => r.Id == target.Id);

        Assert.Empty(reloaded.Photos);
        Assert.Empty(_thumbnailHandler.Requests);
        Assert.Empty(await freshDb.StagedPhotos.AsNoTracking().ToListAsync());
    }

    // ── COMP-0 — reimport replaces single-default with multi-component
    //    while preserving Photos + Custom-Tags ─────────────────────────

    /// <summary>Result JSON with TWO components — a main dish + a
    /// sauce — so the reimport contract test can verify that an existing
    /// recipe with one default component is overwritten with the
    /// multi-component shape, photos stay attached, and the user's
    /// custom tag survives.</summary>
    private const string ReimportResultWithTwoComponents = """
        {
          "recipe": {
            "title": "Quesadillas + Sauce",
            "description": null,
            "servings": 2,
            "difficulty": 2,
            "prep_minutes": 20,
            "cook_minutes": null,
            "components": [
              {
                "position": 0,
                "label": "Hauptgericht",
                "ingredients": [
                  { "name": "Hähnchen", "quantity": "500", "unit": "g", "note": null, "confidence": "high" }
                ],
                "steps": [
                  { "position": 1, "content": "Anbraten.", "confidence": "high" }
                ]
              },
              {
                "position": 1,
                "label": "Chipotle Sauce",
                "ingredients": [
                  { "name": "Chipotle", "quantity": "50", "unit": "g", "note": null, "confidence": "high" },
                  { "name": "Mayo", "quantity": "100", "unit": "g", "note": null, "confidence": "high" }
                ],
                "steps": [
                  { "position": 1, "content": "Pürieren.", "confidence": "high" }
                ]
              }
            ],
            "tags": [],
            "source_url": "https://example.com/rezept"
          },
          "confidence": { "overall": "high", "notes": [] },
          "recipe_empty": false,
          "empty_reason": null
        }
        """;

    [Fact]
    public async Task COMP0_Reimport_Replaces_Single_Default_With_TwoComponent_Shape_Preserving_Photos_And_CustomTags()
    {
        // Seed a target recipe with one default component + three
        // pre-COMP-0-shaped ingredients + one attached photo + one
        // custom tag. After reimport the Photo + Custom tag must
        // survive; Components/Ingredients/Steps must be overwritten
        // with the fresh 2-component shape.
        var customTag = Tag.CreateGroupScoped(_userId, _groupId, "Lieblingsessen");
        _db.Tags.Add(customTag);
        await _db.SaveChangesAsync();

        var target = await SeedTargetRecipeAsync();
        target.AddPhoto("recipes/preserved.jpg");
        await _db.SaveChangesAsync();

        // Seed the single-default component + 3 pre-COMP-0-shaped
        // ingredients via the DbSet so the save doesn't have to
        // reconcile navigation mutations against the tracked Recipe.
        var defaultComponent = new RecipeComponent(target.Id, 0, null);
        _db.RecipeComponents.Add(defaultComponent);
        _db.Ingredients.Add(new Ingredient(target.Id, defaultComponent.Id, 0, 100m, "g", "Alt-A", null, true));
        _db.Ingredients.Add(new Ingredient(target.Id, defaultComponent.Id, 1, 200m, "g", "Alt-B", null, true));
        _db.Ingredients.Add(new Ingredient(target.Id, defaultComponent.Id, 2, 300m, "g", "Alt-C", null, true));
        _db.RecipeTags.Add(new RecipeTag(target.Id, customTag.Id));
        await _db.SaveChangesAsync();

        var import = await SeedReimportAsync(target);
        _handler.QueueResponse(HttpStatusCode.OK, ReimportResultWithTwoComponents);

        await _job.ExecuteAsync(import.Id, CancellationToken.None);

        using var freshDb = new AppDbContext(
            new DbContextOptionsBuilder<AppDbContext>().UseSqlite(_connection).Options);
        var reloaded = await freshDb.Recipes
            .Include(r => r.Components)
            .Include(r => r.Ingredients)
            .Include(r => r.Steps)
            .Include(r => r.RecipeTags)
            .SingleAsync(r => r.Id == target.Id);

        // Title updated; two components now instead of one.
        Assert.Equal("Quesadillas + Sauce", reloaded.Title);
        Assert.Equal(2, reloaded.Components.Count);
        Assert.Contains(reloaded.Components, c => c.Label == "Hauptgericht");
        Assert.Contains(reloaded.Components, c => c.Label == "Chipotle Sauce");

        // Three fresh ingredients (1 main + 2 sauce); no trace of the
        // Alt-A/B/C names from before.
        Assert.Equal(3, reloaded.Ingredients.Count);
        Assert.DoesNotContain(reloaded.Ingredients, i => i.Name.StartsWith("Alt-"));

        // Each ingredient references one of the new component ids.
        var componentIds = reloaded.Components.Select(c => c.Id).ToHashSet();
        Assert.All(reloaded.Ingredients, i => Assert.Contains(i.ComponentId, componentIds));

        // Photos preserved.
        Assert.Single(reloaded.Photos);
        Assert.Equal("recipes/preserved.jpg", reloaded.Photos[0]);

        // Custom tag preserved.
        Assert.Contains(reloaded.RecipeTags, rt => rt.TagId == customTag.Id);
    }

    [Fact]
    public async Task REIMPORT_Missing_Target_Recipe_Marks_Error_Without_Calling_Python()
    {
        var target = await SeedTargetRecipeAsync();
        var import = await SeedReimportAsync(target);

        // Target deleted after enqueue — the job must refuse to run
        // and land the import in Error with `recipe_deleted` instead
        // of surprise-creating a new row.
        _db.Recipes.Remove(target);
        await _db.SaveChangesAsync();

        await _job.ExecuteAsync(import.Id, CancellationToken.None);

        using var freshDb = new AppDbContext(
            new DbContextOptionsBuilder<AppDbContext>().UseSqlite(_connection).Options);
        var reloaded = await freshDb.RecipeImports.AsNoTracking()
            .SingleAsync(i => i.Id == import.Id);
        Assert.Equal(ImportStatus.Error, reloaded.Status);
        Assert.Contains("recipe_deleted", reloaded.ErrorMessage ?? string.Empty);
        // Python was never called — the guard fires before the runner.
        Assert.Empty(_handler.Requests);
    }

    // ── CFG-3: feature.thumbnail_auto_attach_enabled kill switch ───

    [Fact]
    public async Task CFG3_Feature_Flag_False_Skips_Download_And_Insert()
    {
        // Admin flipped the kill switch — the candidate attacher must
        // return an empty array before any HTTP GET / DB insert, even
        // though the extraction result carries a valid whitelisted
        // candidate URL.
        _configReader.Set(CandidateAttacher.FeatureFlagKey, false);

        var import = await SeedImportAsync();
        _handler.QueueResponse(HttpStatusCode.OK, ResultWithFbcdnThumbnail);
        // Deliberately do NOT queue a response on _thumbnailHandler —
        // any GET would blow up, which makes the assertion strict.

        await _job.ExecuteAsync(import.Id, CancellationToken.None);

        var reloaded = await _db.RecipeImports.AsNoTracking()
            .SingleAsync(i => i.Id == import.Id);
        Assert.Equal(ImportStatus.Done, reloaded.Status);
        Assert.Empty(reloaded.CandidateStagedPhotoIds);
        // No HTTP call to the CDN — the flag short-circuits before
        // DownloadAsync is reached.
        Assert.Empty(_thumbnailHandler.Requests);
        // No staged-photo row was inserted either.
        Assert.Empty(_db.StagedPhotos);
    }

    [Fact]
    public async Task CFG3_Feature_Flag_True_Runs_Attacher_As_Before()
    {
        // Belt-and-braces: an explicit true in the reader must leave
        // the existing download + stage behaviour untouched.
        _configReader.Set(CandidateAttacher.FeatureFlagKey, true);

        var import = await SeedImportAsync();
        _handler.QueueResponse(HttpStatusCode.OK, ResultWithFbcdnThumbnail);
        var bytes = FakePngBytes();
        _thumbnailHandler.QueueBytesResponse(HttpStatusCode.OK, bytes, "image/png");

        await _job.ExecuteAsync(import.Id, CancellationToken.None);

        var reloaded = await _db.RecipeImports.AsNoTracking()
            .SingleAsync(i => i.Id == import.Id);
        Assert.Equal(ImportStatus.Done, reloaded.Status);
        Assert.Single(reloaded.CandidateStagedPhotoIds);
        Assert.Single(_thumbnailHandler.Requests);
    }

    [Fact]
    public async Task CFG3_Flag_Row_Missing_Defaults_On()
    {
        // Pristine reader with no keys configured — the
        // defaultValue=true argument kicks in and behaviour matches
        // the pre-CFG-3 baseline.
        var freshReader = new StubExtractorConfigReader();
        var factory = new StubHttpClientFactory(_handler, new Uri("http://python/"));
        factory.RegisterNamedHandler(CandidateAttacher.HttpClientName, _thumbnailHandler);
        CandidateHostResolver publicResolver = (_, _) =>
            Task.FromResult(new[] { System.Net.IPAddress.Parse("93.184.216.34") });
        var attacher = new CandidateAttacher(
            _db, factory, _photoStorage, _clock,
            NullLogger<CandidateAttacher>.Instance,
            freshReader,
            publicResolver);

        var import = await SeedImportAsync();
        _handler.QueueResponse(HttpStatusCode.OK, ResultWithFbcdnThumbnail);
        var bytes = FakePngBytes();
        _thumbnailHandler.QueueBytesResponse(HttpStatusCode.OK, bytes, "image/png");

        // Drive the new attacher through the same extraction path.
        var job = new ExtractRecipeFromUrlJob(
            _db,
            new PythonExtractorRunner(
                _db, factory,
                new ExtractorHmacSigner(
                    Options.Create(new ExtractorOptions { SharedSecret = "test-secret" }),
                    _clock),
                _progressTokens, new NullLiveSyncPublisher(), _clock,
                NullLogger<PythonExtractorRunner>.Instance),
            attacher, _photoStorage, _clock,
            NullLogger<ExtractRecipeFromUrlJob>.Instance);
        await job.ExecuteAsync(import.Id, CancellationToken.None);

        var reloaded = await _db.RecipeImports.AsNoTracking()
            .SingleAsync(i => i.Id == import.Id);
        Assert.Single(reloaded.CandidateStagedPhotoIds);
    }

    // ── COVER-0: candidate list ─────────────────────────────────────

    [Fact]
    public async Task COVER0_Multiple_Candidates_Stage_In_Order()
    {
        // Python emits 3 candidate URLs on fbcdn. Each downloads
        // successfully → three StagedPhoto rows with CandidateOrder
        // 0/1/2, returned in that order via the candidate array.
        var import = await SeedImportAsync();
        _handler.QueueResponse(HttpStatusCode.OK, """
            {
              "recipe": {
                "title": "Multi-Cover",
                "candidate_thumbnails": [
                  "https://scontent-fra3-2.xx.fbcdn.net/v/a.jpg",
                  "https://scontent-fra3-2.xx.fbcdn.net/v/b.jpg",
                  "https://scontent-fra3-2.xx.fbcdn.net/v/c.jpg"
                ]
              },
              "confidence": { "overall": "high", "notes": [] }
            }
            """);
        _thumbnailHandler.QueueBytesResponse(HttpStatusCode.OK, FakePngBytes(), "image/png");
        _thumbnailHandler.QueueBytesResponse(HttpStatusCode.OK, FakePngBytes(), "image/png");
        _thumbnailHandler.QueueBytesResponse(HttpStatusCode.OK, FakePngBytes(), "image/png");

        await _job.ExecuteAsync(import.Id, CancellationToken.None);

        var reloaded = await _db.RecipeImports.AsNoTracking()
            .SingleAsync(i => i.Id == import.Id);
        Assert.Equal(3, reloaded.CandidateStagedPhotoIds.Length);

        var staged = await _db.StagedPhotos.AsNoTracking()
            .Where(s => s.LinkedImportId == import.Id)
            .OrderBy(s => s.CandidateOrder)
            .ToListAsync();
        Assert.Equal(3, staged.Count);
        Assert.Equal(new int?[] { 0, 1, 2 }, staged.Select(s => s.CandidateOrder).ToArray());
    }

    [Fact]
    public async Task COVER0_Missing_Candidate_Array_Yields_No_Candidates()
    {
        // COVER-0 cleanup: when the extractor emits neither
        // candidate_thumbnails nor any legacy fallback, the .NET side
        // stages nothing. The extractor preserves the default-cover UX
        // by seeding candidate_thumbnails[0] from its single-URL paths
        // (og:image, yt-dlp scalar thumbnail), so a missing array here
        // means the extractor really did yield zero candidates.
        var import = await SeedImportAsync();
        _handler.QueueResponse(HttpStatusCode.OK, """
            {
              "recipe": {
                "title": "NoCover"
              },
              "confidence": { "overall": "high", "notes": [] }
            }
            """);

        await _job.ExecuteAsync(import.Id, CancellationToken.None);

        var reloaded = await _db.RecipeImports.AsNoTracking()
            .SingleAsync(i => i.Id == import.Id);
        Assert.Empty(reloaded.CandidateStagedPhotoIds);
        Assert.Empty(_thumbnailHandler.Requests);
    }

    // ── LANG-1: outbound Accept-Language propagation ─────────────────

    [Theory]
    [InlineData("de")]
    [InlineData("en")]
    public async Task Job_Forwards_RequestedLanguage_As_Accept_Language(string lang)
    {
        var import = await SeedImportWithLanguageAsync(lang);
        _handler.QueueResponse(HttpStatusCode.OK, "{\"title\":\"x\"}");

        await _job.ExecuteAsync(import.Id, CancellationToken.None);

        var req = Assert.Single(_handler.Requests);
        Assert.True(
            req.Headers.TryGetValue("Accept-Language", out var headerValue),
            "Outbound Python POST must carry the Accept-Language header.");
        Assert.Equal(lang, headerValue);
    }

    [Fact]
    public async Task Job_Falls_Back_To_English_When_RequestedLanguage_Is_Null()
    {
        // Pre-LANG-1 row scenario: imports created before the migration
        // have no language stored. The runner must default to "en"
        // (matches REL-3h on the web side) so the LLM emits English
        // values rather than crashing on a null header.
        var import = await SeedImportAsync();  // no requested language
        _handler.QueueResponse(HttpStatusCode.OK, "{\"title\":\"x\"}");

        await _job.ExecuteAsync(import.Id, CancellationToken.None);

        var req = Assert.Single(_handler.Requests);
        Assert.True(req.Headers.TryGetValue("Accept-Language", out var headerValue));
        Assert.Equal("en", headerValue);
    }
}
