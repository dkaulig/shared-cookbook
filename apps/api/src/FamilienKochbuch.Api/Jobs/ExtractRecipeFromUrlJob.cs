using FamilienKochbuch.Api.Services;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Infrastructure.Persistence;
using Hangfire;
using Microsoft.EntityFrameworkCore;

namespace FamilienKochbuch.Api.Jobs;

/// <summary>
/// Hangfire job that drives a URL-based recipe extraction end-to-end.
///
/// This class is a thin wrapper — all transport + progress + retry
/// logic lives on <see cref="PythonExtractorRunner"/>. The job's job
/// is to load the import, sanity-check it's a URL source, and hand off
/// to the shared runner with the right relative URL + body.
///
/// The <c>[AutomaticRetry]</c> attribute with <c>Attempts = 3</c>
/// covers transient 5xx + network errors only; terminal 4xx errors
/// throw an <see cref="PythonExtractorException"/> with
/// <c>IsTerminal = true</c>.
/// </summary>
[AutomaticRetry(Attempts = 3)]
public class ExtractRecipeFromUrlJob
{
    /// <summary>Named HttpClient registered against the Python service.</summary>
    public const string HttpClientName = "python-extractor";

    private readonly AppDbContext _db;
    private readonly PythonExtractorRunner _runner;

    public ExtractRecipeFromUrlJob(AppDbContext db, PythonExtractorRunner runner)
    {
        _db = db;
        _runner = runner;
    }

    /// <summary>Entry point invoked by Hangfire. Public for EF's DI
    /// integration; callers outside Hangfire should go through
    /// <c>BackgroundJob.Enqueue&lt;ExtractRecipeFromUrlJob&gt;(j =&gt;
    /// j.ExecuteAsync(importId, CancellationToken.None))</c>.</summary>
    public async Task ExecuteAsync(Guid importId, CancellationToken ct)
    {
        var import = await _db.RecipeImports.SingleOrDefaultAsync(i => i.Id == importId, ct)
            ?? throw new InvalidOperationException(
                $"RecipeImport {importId} not found; was it deleted before the job ran?");

        if (import.Source != ImportSource.Url)
            throw new InvalidOperationException(
                $"RecipeImport {importId} has source {import.Source}; expected Url.");

        if (string.IsNullOrWhiteSpace(import.SourceUrl))
            throw new InvalidOperationException(
                $"RecipeImport {importId} has no SourceUrl; cannot dispatch URL extraction.");

        await _runner.RunAsync(
            import,
            relativeUrl: "/extract/url",
            buildBody: i => new
            {
                url = i.SourceUrl,
                hint = new { group_id = i.GroupId.ToString("D"), user_id = i.UserId.ToString("D") },
            },
            ct);
    }
}
