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
        _job = new ExtractRecipeFromPhotosJob(_db, runner);
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
