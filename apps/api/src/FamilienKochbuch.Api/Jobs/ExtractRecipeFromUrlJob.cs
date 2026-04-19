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

    // PF2 header names — must match the constants on the Python side
    // (extractor/main.py). Changing either without the other is a
    // breaking contract bug.
    public const string PromptTokensHeader = "X-Extractor-Prompt-Tokens";
    public const string CompletionTokensHeader = "X-Extractor-Completion-Tokens";
    public const string CachedTokensHeader = "X-Extractor-Cached-Tokens";
    public const string ModelHeader = "X-Extractor-Model";

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

    /// <summary>Attempt to parse all four PF2 token-usage headers off
    /// a Python response. Any missing / malformed header yields
    /// <c>false</c> — the caller skips <see cref="RecipeImport.RecordUsage"/>
    /// and the row stays with NULL usage columns. We deliberately
    /// don't fail the job on bad headers because the extraction
    /// itself succeeded; the headers are telemetry.</summary>
    public static bool TryReadUsageHeaders(
        HttpResponseMessage response,
        out int promptTokens,
        out int completionTokens,
        out int cachedPromptTokens,
        out string modelDeployment)
    {
        promptTokens = 0;
        completionTokens = 0;
        cachedPromptTokens = 0;
        modelDeployment = string.Empty;

        if (!TryParseIntHeader(response, PromptTokensHeader, out promptTokens)) return false;
        if (!TryParseIntHeader(response, CompletionTokensHeader, out completionTokens)) return false;
        if (!TryParseIntHeader(response, CachedTokensHeader, out cachedPromptTokens)) return false;
        if (!response.Headers.TryGetValues(ModelHeader, out var modelValues)) return false;

        var model = modelValues?.FirstOrDefault();
        if (string.IsNullOrWhiteSpace(model)) return false;
        if (promptTokens < 0 || completionTokens < 0 || cachedPromptTokens < 0) return false;
        // Same invariant RecordUsage enforces — guard here so the
        // domain throw never fires on telemetry.
        if (cachedPromptTokens > promptTokens) return false;

        modelDeployment = model;
        return true;
    }

    private static bool TryParseIntHeader(HttpResponseMessage response, string name, out int value)
    {
        value = 0;
        if (!response.Headers.TryGetValues(name, out var values)) return false;
        var raw = values?.FirstOrDefault();
        return int.TryParse(raw, out value);
    }
}
