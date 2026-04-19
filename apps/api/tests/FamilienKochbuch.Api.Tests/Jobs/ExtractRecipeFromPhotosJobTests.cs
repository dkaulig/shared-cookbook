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
/// Integration tests for <see cref="ExtractRecipeFromPhotosJob"/>. The
/// job shares the RunAsync pipeline with <see cref="ExtractRecipeFromUrlJob"/>,
/// so the main distinct behaviour to cover here is: the photo URL list
/// is read from <c>ResultJson</c>, the request hits <c>/extract/photos</c>,
/// and the body carries the ordered URL array.
/// </summary>
public class ExtractRecipeFromPhotosJobTests : IAsyncLifetime
{
    private SqliteConnection _connection = null!;
    private AppDbContext _db = null!;
    private Guid _userId;
    private Guid _groupId;
    private StubHttpMessageHandler _handler = null!;
    private ExtractRecipeFromPhotosJob _job = null!;
    private FakeTimeProvider _clock = null!;
    private ImportProgressTokenService _progressTokens = null!;

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
        var factory = new StubHttpClientFactory(_handler, new Uri("http://python/"));
        _clock = new FakeTimeProvider(new DateTimeOffset(2026, 4, 18, 12, 0, 0, TimeSpan.Zero));
        var extractorOpts = Options.Create(new ExtractorOptions { SharedSecret = "test-secret" });
        var signer = new ExtractorHmacSigner(extractorOpts, _clock);
        _progressTokens = new ImportProgressTokenService(extractorOpts);
        var runner = new PythonExtractorRunner(
            _db, factory, signer, _progressTokens, new NullLiveSyncPublisher(), _clock,
            NullLogger<PythonExtractorRunner>.Instance);
        // BUG-011 — the job needs FrontendBaseUrl so it can promote
        // path-absolute photo URLs to absolute before forwarding.
        var appOpts = Options.Create(new AppOptions { FrontendBaseUrl = "https://kochbuch.test" });
        _job = new ExtractRecipeFromPhotosJob(_db, runner, appOpts);
    }

    public async Task DisposeAsync()
    {
        await _db.DisposeAsync();
        await _connection.DisposeAsync();
    }

    private async Task<RecipeImport> SeedImportAsync(string[] urls)
    {
        var import = new RecipeImport(
            _userId, _groupId, ImportSource.Photos, sourceUrl: null, _clock.GetUtcNow());
        _db.RecipeImports.Add(import);
        await _db.SaveChangesAsync();

        // Seed the transit URL list via ResultJson (the P2-6 enqueue
        // endpoint will do this; tests fake it directly).
        import.GetType()
            .GetProperty(nameof(RecipeImport.ResultJson))!
            .SetValue(import, JsonSerializer.Serialize(urls));
        await _db.SaveChangesAsync();
        return import;
    }

    [Fact]
    public async Task Happy_Path_POSTs_Ordered_Photo_Urls_To_Extract_Photos()
    {
        var urls = new[]
        {
            "https://photos/1.jpg",
            "https://photos/2.jpg",
        };
        var import = await SeedImportAsync(urls);
        _handler.QueueResponse(HttpStatusCode.OK, "{\"title\":\"Foto-Rezept\"}");

        await _job.ExecuteAsync(import.Id, CancellationToken.None);

        var req = Assert.Single(_handler.Requests);
        Assert.Equal("http://python/extract/photos", req.Uri.ToString());
        Assert.Contains("\"photo_urls\":[", req.Body);
        Assert.Contains("https://photos/1.jpg", req.Body);
        Assert.Contains("https://photos/2.jpg", req.Body);

        var reloaded = await _db.RecipeImports.AsNoTracking()
            .SingleAsync(i => i.Id == import.Id);
        Assert.Equal(ImportStatus.Done, reloaded.Status);
        Assert.Equal("{\"title\":\"Foto-Rezept\"}", reloaded.ResultJson);
    }

    [Fact]
    public async Task Happy_Path_Persists_Token_Usage_From_Headers()
    {
        var import = await SeedImportAsync(new[] { "https://photos/1.jpg" });
        _handler.QueueResponseWithUsage(
            HttpStatusCode.OK,
            "{\"title\":\"Foto-Rezept\"}",
            promptTokens: 3000,
            completionTokens: 600,
            cachedPromptTokens: 0,
            model: "gpt-4.1-mini");

        await _job.ExecuteAsync(import.Id, CancellationToken.None);

        var reloaded = await _db.RecipeImports.AsNoTracking()
            .SingleAsync(i => i.Id == import.Id);
        Assert.Equal(3000, reloaded.PromptTokens);
        Assert.Equal(600, reloaded.CompletionTokens);
        Assert.Equal(0, reloaded.CachedPromptTokens);
        Assert.Equal("gpt-4.1-mini", reloaded.ModelDeployment);
    }

    [Fact]
    public async Task Missing_Photo_List_Throws()
    {
        var import = new RecipeImport(
            _userId, _groupId, ImportSource.Photos, sourceUrl: null, _clock.GetUtcNow());
        _db.RecipeImports.Add(import);
        await _db.SaveChangesAsync();

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => _job.ExecuteAsync(import.Id, CancellationToken.None));
    }

    [Fact]
    public async Task Url_Source_Rejected_By_Photos_Job()
    {
        var import = new RecipeImport(
            _userId, _groupId, ImportSource.Url, "https://x", _clock.GetUtcNow());
        _db.RecipeImports.Add(import);
        await _db.SaveChangesAsync();

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => _job.ExecuteAsync(import.Id, CancellationToken.None));
        Assert.Empty(_handler.Requests);
    }

    // ── PV2 hotfix regression tests ─────────────────────────────────
    // Mirror the URL job regressions against /extract/photos — same
    // callback envelope, same failure mode.

    [Fact]
    public async Task Outbound_Body_Carries_Progress_Callback_Fields()
    {
        var import = await SeedImportAsync(new[] { "https://photos/1.jpg" });
        _handler.QueueResponse(HttpStatusCode.OK, "{\"title\":\"x\"}");

        await _job.ExecuteAsync(import.Id, CancellationToken.None);

        var req = Assert.Single(_handler.Requests);
        using var doc = JsonDocument.Parse(req.Body!);
        var root = doc.RootElement;

        Assert.Equal(
            $"http://api:5000/api/internal/imports/{import.Id:D}/progress",
            root.GetProperty("callback_url").GetString());

        var token = root.GetProperty("callback_token").GetString();
        Assert.False(string.IsNullOrEmpty(token));
        Assert.True(_progressTokens.TryVerify(
            token, import.Id, _clock.GetUtcNow(), out var failure),
            $"token failed: {failure}");

        Assert.Equal(import.Id.ToString("D"), root.GetProperty("import_id").GetString());
        Assert.Equal(import.AttemptNumber, root.GetProperty("attempt").GetInt32());

        // photo_urls payload survives the merge.
        Assert.Equal(JsonValueKind.Array, root.GetProperty("photo_urls").ValueKind);
    }

    [Fact]
    public async Task Callback_Base_Url_Honours_Env_Override()
    {
        var original = Environment.GetEnvironmentVariable(PythonExtractorRunner.CallbackBaseUrlEnvVar);
        Environment.SetEnvironmentVariable(
            PythonExtractorRunner.CallbackBaseUrlEnvVar,
            "http://api-host.test:9999");
        try
        {
            var import = await SeedImportAsync(new[] { "https://photos/1.jpg" });
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

    // ── BUG-011 regression — relative photo URLs must be absolutized
    //    before forwarding to Python so pydantic HttpUrl accepts them
    //    AND Azure Vision can fetch them publicly. ─────────────────────

    [Fact]
    public async Task BUG011_Relative_Photo_Urls_Are_Promoted_To_Absolute_Before_Forwarding()
    {
        // Mirrors what the frontend ImportPhotosPage actually sends
        // today: signed URLs returned by uploadStagedPhoto() are
        // path-absolute (`/api/photos/recipes/...?sig=...&exp=...`)
        // because the browser already knows the origin.
        var relative = new[]
        {
            "/api/photos/recipes/photo-a.jpg?sig=AAA&exp=9999999999",
            "/api/photos/recipes/photo-b.jpg?sig=BBB&exp=9999999999",
        };
        var import = await SeedImportAsync(relative);
        _handler.QueueResponse(HttpStatusCode.OK, "{\"title\":\"x\"}");

        await _job.ExecuteAsync(import.Id, CancellationToken.None);

        var req = Assert.Single(_handler.Requests);
        using var doc = JsonDocument.Parse(req.Body!);
        var photoUrls = doc.RootElement.GetProperty("photo_urls");
        Assert.Equal(JsonValueKind.Array, photoUrls.ValueKind);
        Assert.Equal(2, photoUrls.GetArrayLength());

        // Every outbound URL must be absolute http(s) — that's the
        // pydantic + Azure-Vision-fetchable contract.
        foreach (var el in photoUrls.EnumerateArray())
        {
            var url = el.GetString();
            Assert.NotNull(url);
            Assert.StartsWith("https://", url);
        }

        // Order is preserved + the FrontendBaseUrl is concatenated
        // exactly once.
        Assert.Equal(
            "https://kochbuch.test/api/photos/recipes/photo-a.jpg?sig=AAA&exp=9999999999",
            photoUrls[0].GetString());
        Assert.Equal(
            "https://kochbuch.test/api/photos/recipes/photo-b.jpg?sig=BBB&exp=9999999999",
            photoUrls[1].GetString());
    }

    [Fact]
    public async Task BUG011_Already_Absolute_Photo_Urls_Pass_Through_Unchanged()
    {
        // Backward-compat: any URL that already starts with http[s]
        // must reach Python verbatim — manual / test callers, future
        // remote-image flows, and existing integration tests rely on
        // this.
        var absolute = new[]
        {
            "https://photos/1.jpg",
            "http://photos/2.jpg",
        };
        var import = await SeedImportAsync(absolute);
        _handler.QueueResponse(HttpStatusCode.OK, "{\"title\":\"x\"}");

        await _job.ExecuteAsync(import.Id, CancellationToken.None);

        var req = Assert.Single(_handler.Requests);
        using var doc = JsonDocument.Parse(req.Body!);
        var photoUrls = doc.RootElement.GetProperty("photo_urls");
        Assert.Equal("https://photos/1.jpg", photoUrls[0].GetString());
        Assert.Equal("http://photos/2.jpg", photoUrls[1].GetString());
    }

    [Theory]
    [InlineData("/api/photos/recipes/x.jpg?sig=A&exp=9", "https://kochbuch.test", "https://kochbuch.test/api/photos/recipes/x.jpg?sig=A&exp=9")]
    [InlineData("/api/photos/recipes/x.jpg?sig=A&exp=9", "https://kochbuch.test/", "https://kochbuch.test/api/photos/recipes/x.jpg?sig=A&exp=9")]
    [InlineData("https://other.example/p.jpg", "https://kochbuch.test", "https://other.example/p.jpg")]
    [InlineData("HTTPS://Other.example/p.jpg", "https://kochbuch.test", "HTTPS://Other.example/p.jpg")]
    public void BUG011_AbsolutizePhotoUrl_Theory(string raw, string baseUrl, string expected)
    {
        var actual = ExtractRecipeFromPhotosJob.AbsolutizePhotoUrl(raw, baseUrl);
        Assert.Equal(expected, actual);
    }

    [Fact]
    public void BUG011_AbsolutizePhotoUrl_Rejects_Path_Relative_Input()
    {
        // "api/photos/..." (no leading slash) is path-relative and
        // would join ambiguously with the base URL — refuse loudly so
        // any future regression in the enqueue validator surfaces in
        // the Hangfire failure log instead of producing a 404 on
        // Azure's side.
        var ex = Assert.Throws<InvalidOperationException>(() =>
            ExtractRecipeFromPhotosJob.AbsolutizePhotoUrl(
                "api/photos/x.jpg", "https://kochbuch.test"));
        Assert.Contains("path-absolute", ex.Message);
    }

    [Fact]
    public void BUG011_AbsolutizePhotoUrl_Requires_FrontendBaseUrl_For_Relative()
    {
        var ex = Assert.Throws<InvalidOperationException>(() =>
            ExtractRecipeFromPhotosJob.AbsolutizePhotoUrl(
                "/api/photos/x.jpg", string.Empty));
        Assert.Contains("FrontendBaseUrl", ex.Message);
    }

    [Fact]
    public async Task Token_Is_Scoped_To_Import_Id()
    {
        // A token minted for import A must NOT verify against import B —
        // that's the whole point of the per-importId scope. Sanity-check
        // the scoping at the integration level, not just the unit-test
        // level, so accidental runner-side mis-wiring (wrong importId
        // passed into Sign) shows up here.
        var importA = await SeedImportAsync(new[] { "https://photos/a.jpg" });
        _handler.QueueResponse(HttpStatusCode.OK, "{\"title\":\"x\"}");

        await _job.ExecuteAsync(importA.Id, CancellationToken.None);

        var req = Assert.Single(_handler.Requests);
        using var doc = JsonDocument.Parse(req.Body!);
        var token = doc.RootElement.GetProperty("callback_token").GetString();

        // Verify against a *different* importId — must fail WrongImport.
        var otherId = Guid.NewGuid();
        Assert.False(_progressTokens.TryVerify(
            token, otherId, _clock.GetUtcNow(), out var failure));
        Assert.Equal(ImportTokenValidationFailure.WrongImport, failure);
    }
}
