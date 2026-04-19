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
    private StubHttpMessageHandler _thumbnailHandler = null!;
    private ExtractRecipeFromUrlJob _job = null!;
    private FakeTimeProvider _clock = null!;
    private ImportProgressTokenService _progressTokens = null!;
    private FakePhotoStorage _photoStorage = null!;

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
        // BUG-018 — route the thumbnail-downloader's named client to a
        // dedicated handler so the Python POST and the CDN GET stay
        // request-isolated.
        factory.RegisterNamedHandler(ThumbnailAttacher.HttpClientName, _thumbnailHandler);

        _clock = new FakeTimeProvider(new DateTimeOffset(2026, 4, 18, 12, 0, 0, TimeSpan.Zero));
        var extractorOpts = Options.Create(new ExtractorOptions { SharedSecret = "test-secret" });
        var signer = new ExtractorHmacSigner(extractorOpts, _clock);
        _progressTokens = new ImportProgressTokenService(extractorOpts);
        var runner = new PythonExtractorRunner(
            _db, factory, signer, _progressTokens, new NullLiveSyncPublisher(), _clock,
            NullLogger<PythonExtractorRunner>.Instance);
        _photoStorage = new FakePhotoStorage();
        var thumbnailAttacher = new ThumbnailAttacher(
            _db, factory, _photoStorage, _clock,
            NullLogger<ThumbnailAttacher>.Instance);
        _job = new ExtractRecipeFromUrlJob(_db, runner, thumbnailAttacher);
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
    // carries a `recipe.thumbnail_url`, the job downloads that URL,
    // uploads it to SeaweedFS, persists a StagedPhoto row, and links
    // the staged-photo id to the import via
    // ThumbnailStagedPhotoId. Failures of the thumbnail step never
    // surface — the recipe creation must always succeed.

    /// <summary>Result JSON the Python pipeline would emit, with a
    /// known-allowed FB-CDN thumbnail URL.</summary>
    private const string ResultWithFbcdnThumbnail = """
        {
          "recipe": {
            "title": "Pizza",
            "thumbnail_url": "https://scontent-fra3-2.xx.fbcdn.net/v/thumb.jpg"
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
        Assert.NotNull(reloaded.ThumbnailStagedPhotoId);

        // StagedPhoto row was actually persisted with the same id, owned
        // by the same user, with the upload's bytes mirrored into storage.
        var staged = await _db.StagedPhotos.AsNoTracking()
            .SingleAsync(s => s.Id == reloaded.ThumbnailStagedPhotoId);
        Assert.Equal(_userId, staged.UserId);
        Assert.Equal("image/png", staged.ContentType);
        Assert.True(_photoStorage.Uploads.ContainsKey(staged.PhotoId));
        Assert.Equal(bytes, _photoStorage.Uploads[staged.PhotoId].Content);

        // Sanity — the thumbnail GET hit the CDN URL exactly once.
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
        Assert.Null(reloaded.ThumbnailStagedPhotoId);
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
            declaredContentLength: ThumbnailAttacher.MaxBytes + 1);

        await _job.ExecuteAsync(import.Id, CancellationToken.None);

        var reloaded = await _db.RecipeImports.AsNoTracking()
            .SingleAsync(i => i.Id == import.Id);
        Assert.Equal(ImportStatus.Done, reloaded.Status);
        Assert.Null(reloaded.ThumbnailStagedPhotoId);
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
        Assert.Null(reloaded.ThumbnailStagedPhotoId);
        Assert.Empty(_photoStorage.Uploads);
    }

    [Fact]
    public async Task BUG018_Result_Without_Thumbnail_Url_Skips_Download_Entirely()
    {
        // No `thumbnail_url` in the structured result → no CDN GET, no
        // storage write, ThumbnailStagedPhotoId stays null. This is the
        // common blog-import path.
        var import = await SeedImportAsync();
        _handler.QueueResponse(
            HttpStatusCode.OK,
            "{\"recipe\": {\"title\": \"Blog Pizza\"}, \"confidence\": {\"overall\": \"high\", \"notes\": []}}");

        await _job.ExecuteAsync(import.Id, CancellationToken.None);

        var reloaded = await _db.RecipeImports.AsNoTracking()
            .SingleAsync(i => i.Id == import.Id);
        Assert.Equal(ImportStatus.Done, reloaded.Status);
        Assert.Null(reloaded.ThumbnailStagedPhotoId);
        Assert.Empty(_thumbnailHandler.Requests);
        Assert.Empty(_photoStorage.Uploads);
    }

    [Fact]
    public async Task BUG018_Disallowed_Host_Rejects_Without_Network_Hit()
    {
        // SSRF guard: a thumbnail_url pointing at a host outside the
        // CDN allowlist (e.g. an attacker plant pointing at an internal
        // service) must be rejected *before* any HTTP call is made.
        var import = await SeedImportAsync();
        _handler.QueueResponse(
            HttpStatusCode.OK,
            """
            {
              "recipe": {
                "title": "Evil",
                "thumbnail_url": "http://169.254.169.254/latest/meta-data/iam/security-credentials/"
              },
              "confidence": { "overall": "high", "notes": [] }
            }
            """);

        await _job.ExecuteAsync(import.Id, CancellationToken.None);

        var reloaded = await _db.RecipeImports.AsNoTracking()
            .SingleAsync(i => i.Id == import.Id);
        Assert.Equal(ImportStatus.Done, reloaded.Status);
        Assert.Null(reloaded.ThumbnailStagedPhotoId);
        // The thumbnail handler must not have been touched at all.
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
        Assert.Equal(allowed, ThumbnailAttacher.IsAllowedThumbnailHost(url, out _));
    }
}
