using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using FamilienKochbuch.Api.Services;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Infrastructure.Persistence;
using Hangfire;
using Microsoft.EntityFrameworkCore;

namespace FamilienKochbuch.Api.Jobs;

/// <summary>
/// Hangfire job that drives a URL-based recipe extraction end-to-end.
///
/// The job:
/// <list type="number">
/// <item>Loads the owning <see cref="RecipeImport"/> row.</item>
/// <item>Marks it <see cref="ImportStatus.Running"/> with progress = 10.</item>
/// <item>POSTs the URL + hint to the Python service
/// (<c>/extract/url</c>), signed via <see cref="ExtractorHmacSigner"/>.</item>
/// <item>On 2xx, bumps progress to 95 before persisting the JSON
/// result and transitioning to <see cref="ImportStatus.Done"/>
/// (progress 100 via <see cref="RecipeImport.MarkDone"/>).</item>
/// <item>On Python 4xx (<see cref="PythonExtractorException.IsTerminal"/>
/// = true), transitions to <see cref="ImportStatus.Error"/> and throws
/// so Hangfire records the failure without retrying. The
/// <c>[AutomaticRetry]</c> attribute with <c>Attempts = 3</c> covers
/// transient 5xx + network errors only.</item>
/// </list>
///
/// Progress steps are intentionally coarse (10 → 40 → 95) because the
/// job can't observe Python's internal stages without a second channel;
/// the timestamps the UI cares about are "started", "server got
/// response", "saved".
/// </summary>
[AutomaticRetry(Attempts = 3)]
public class ExtractRecipeFromUrlJob
{
    /// <summary>Named HttpClient registered against the Python service.</summary>
    public const string HttpClientName = "python-extractor";

    private readonly AppDbContext _db;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ExtractorHmacSigner _signer;
    private readonly TimeProvider _clock;

    public ExtractRecipeFromUrlJob(
        AppDbContext db,
        IHttpClientFactory httpClientFactory,
        ExtractorHmacSigner signer,
        TimeProvider clock)
    {
        _db = db;
        _httpClientFactory = httpClientFactory;
        _signer = signer;
        _clock = clock;
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

        await RunAsync(
            import,
            relativeUrl: "/extract/url",
            buildBody: () => new
            {
                url = import.SourceUrl,
                hint = new { group_id = import.GroupId.ToString("D"), user_id = import.UserId.ToString("D") },
            },
            ct);
    }

    // ── Internal shape, also used by the Photos job via composition ──

    internal async Task RunAsync(
        RecipeImport import,
        string relativeUrl,
        Func<object> buildBody,
        CancellationToken ct)
    {
        import.MarkRunning(10);
        await _db.SaveChangesAsync(ct);

        var client = _httpClientFactory.CreateClient(HttpClientName);
        using var request = new HttpRequestMessage(HttpMethod.Post, relativeUrl)
        {
            Content = JsonContent.Create(buildBody()),
        };
        await _signer.ApplyAsync(request, import.UserId, ct);

        HttpResponseMessage response;
        string bodyText;
        try
        {
            response = await client.SendAsync(request, ct).ConfigureAwait(false);
            bodyText = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        }
        catch (HttpRequestException ex)
        {
            // Transport-level failure — transient. Let Hangfire retry.
            throw new PythonExtractorException(
                "Python extractor unreachable.", isTerminal: false, statusCode: null, ex);
        }
        catch (TaskCanceledException ex) when (!ct.IsCancellationRequested)
        {
            // httpclient timeout — also transient.
            throw new PythonExtractorException(
                "Python extractor timed out.", isTerminal: false, statusCode: null, ex);
        }

        using (response)
        {
            if (response.IsSuccessStatusCode)
            {
                import.MarkRunning(95);
                await _db.SaveChangesAsync(ct);

                var json = ValidateJsonOrThrow(bodyText);
                import.MarkDone(json, _clock.GetUtcNow());
                await _db.SaveChangesAsync(ct);
                return;
            }

            var status = (int)response.StatusCode;
            var terminal = status is >= 400 and < 500;
            var message = ExtractErrorMessage(bodyText, status);

            if (terminal)
            {
                // 4xx — persist Error state and stop retrying.
                import.MarkError(message, _clock.GetUtcNow());
                await _db.SaveChangesAsync(ct);
                throw new PythonExtractorException(message, isTerminal: true, statusCode: status);
            }

            // 5xx — leave the row in Running so a retry can transition
            // it normally; throw so Hangfire's AutomaticRetry picks it
            // up. When the retry budget is exhausted Hangfire records a
            // "Failed" state in its own store; the RecipeImport row
            // stays in Running — the status endpoint surfaces the
            // incident via the Hangfire dashboard for admins to retry
            // or kill manually. Deliberate trade-off, see plan §5.
            throw new PythonExtractorException(message, isTerminal: false, statusCode: status);
        }
    }

    private static string ValidateJsonOrThrow(string bodyText)
    {
        if (string.IsNullOrWhiteSpace(bodyText))
            throw new PythonExtractorException(
                "Python extractor returned an empty body.",
                isTerminal: false,
                statusCode: (int)HttpStatusCode.BadGateway);
        try
        {
            using var _ = JsonDocument.Parse(bodyText);
        }
        catch (JsonException ex)
        {
            throw new PythonExtractorException(
                "Python extractor returned malformed JSON.",
                isTerminal: false,
                statusCode: (int)HttpStatusCode.BadGateway,
                ex);
        }
        return bodyText;
    }

    private static string ExtractErrorMessage(string bodyText, int status)
    {
        // FastAPI convention: { "detail": "..." }. Fall back to status
        // code on anything non-shape-conforming so the RecipeImport row
        // always has a user-readable reason.
        if (!string.IsNullOrWhiteSpace(bodyText))
        {
            try
            {
                using var doc = JsonDocument.Parse(bodyText);
                if (doc.RootElement.ValueKind == JsonValueKind.Object
                    && doc.RootElement.TryGetProperty("detail", out var detail)
                    && detail.ValueKind == JsonValueKind.String)
                {
                    var s = detail.GetString();
                    if (!string.IsNullOrWhiteSpace(s)) return s!;
                }
            }
            catch (JsonException)
            {
                // Ignore — fall through to generic message.
            }
        }
        return $"Python extractor returned HTTP {status}.";
    }
}
