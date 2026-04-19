using System.Net;
using FamilienKochbuch.Api.Jobs;
using FamilienKochbuch.Api.Services;
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
    private ExtractRecipeFromUrlJob _job = null!;
    private FakeTimeProvider _clock = null!;

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
        var signer = new ExtractorHmacSigner(
            Options.Create(new ExtractorOptions { SharedSecret = "test-secret" }),
            _clock);
        var runner = new PythonExtractorRunner(
            _db, factory, signer, _clock, NullLogger<PythonExtractorRunner>.Instance);
        _job = new ExtractRecipeFromUrlJob(_db, runner);
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
}
