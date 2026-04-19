using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using FamilienKochbuch.Api.Jobs;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace FamilienKochbuch.Api.Services;

/// <summary>
/// Shared transport for the two extraction jobs. Owns the HTTP call +
/// retry-classification shape so the URL / Photos jobs stay thin
/// wrappers that only differ in relative-URL + request body.
///
/// Behaviour:
/// <list type="number">
/// <item>Loads the owning <see cref="RecipeImport"/>.</item>
/// <item>Marks it <see cref="ImportStatus.Running"/> with progress = 10.</item>
/// <item>POSTs the body to the configured relative URL
/// (<c>/extract/url</c> or <c>/extract/photos</c>), signed via
/// <see cref="ExtractorHmacSigner"/>.</item>
/// <item>On 2xx, bumps progress to 95, persists token usage (if the
/// <c>X-Extractor-*</c> headers are present) and transitions to
/// <see cref="ImportStatus.Done"/>.</item>
/// <item>On Python 4xx, transitions to <see cref="ImportStatus.Error"/>
/// and throws a terminal <see cref="PythonExtractorException"/> so
/// Hangfire records the failure without retrying.</item>
/// <item>On 5xx / transport / timeout, leaves the row in Running and
/// throws a non-terminal exception so Hangfire's
/// <c>[AutomaticRetry]</c> picks it up.</item>
/// </list>
/// </summary>
public sealed class PythonExtractorRunner
{
    private readonly AppDbContext _db;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ExtractorHmacSigner _signer;
    private readonly TimeProvider _clock;
    private readonly ILogger<PythonExtractorRunner> _logger;

    public PythonExtractorRunner(
        AppDbContext db,
        IHttpClientFactory httpClientFactory,
        ExtractorHmacSigner signer,
        TimeProvider clock,
        ILogger<PythonExtractorRunner> logger)
    {
        _db = db;
        _httpClientFactory = httpClientFactory;
        _signer = signer;
        _clock = clock;
        _logger = logger;
    }

    /// <summary>Entry point used by both extraction jobs. The caller
    /// supplies the relative URL (<c>/extract/url</c> or
    /// <c>/extract/photos</c>) and a factory that produces the request
    /// body from the already-loaded <see cref="RecipeImport"/>.</summary>
    public async Task RunAsync(
        RecipeImport import,
        string relativeUrl,
        Func<RecipeImport, object> buildBody,
        CancellationToken ct)
    {
        import.MarkRunning(10);
        await _db.SaveChangesAsync(ct);

        var client = _httpClientFactory.CreateClient(ExtractRecipeFromUrlJob.HttpClientName);
        using var request = new HttpRequestMessage(HttpMethod.Post, relativeUrl)
        {
            Content = JsonContent.Create(buildBody(import)),
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

                // Pull token-usage headers + record them on the import
                // *before* MarkDone transitions to terminal state.
                // Headers absent (e.g. mock provider, older Python
                // build) → skip silently; a null-usage row is
                // acceptable and just hides from the admin dashboard.
                if (ExtractRecipeFromUrlJob.TryReadUsageHeaders(response, out var prompt,
                        out var completion, out var cached, out var model))
                {
                    import.RecordUsage(prompt, completion, cached, model);
                }

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
            // or kill manually.
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
