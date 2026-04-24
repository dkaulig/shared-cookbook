using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using FamilienKochbuch.Api.Hubs;
using FamilienKochbuch.Api.Jobs;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.Enums;
using FamilienKochbuch.Infrastructure.Persistence;

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
    /// <summary>Default docker-internal base URL for the .NET API, used
    /// when <c>API_INTERNAL_BASE_URL</c> is not set. Matches the api
    /// service hostname/port on the default compose network so Python
    /// can reach <c>/api/internal/imports/{id}/progress</c> for progress
    /// callbacks without any extra routing config.</summary>
    public const string DefaultCallbackBaseUrl = "http://api:5000";

    /// <summary>Env var the compose files expose on the api container so
    /// ops can point Python at the api over a different hostname (e.g.
    /// the host-side loopback in a test environment) without a rebuild.</summary>
    public const string CallbackBaseUrlEnvVar = "API_INTERNAL_BASE_URL";

    private readonly AppDbContext _db;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ExtractorHmacSigner _signer;
    private readonly ImportProgressTokenService _progressTokens;
    private readonly ILiveSyncPublisher _liveSync;
    private readonly TimeProvider _clock;
    private readonly ILogger<PythonExtractorRunner> _logger;

    public PythonExtractorRunner(
        AppDbContext db,
        IHttpClientFactory httpClientFactory,
        ExtractorHmacSigner signer,
        ImportProgressTokenService progressTokens,
        ILiveSyncPublisher liveSync,
        TimeProvider clock,
        ILogger<PythonExtractorRunner> logger)
    {
        _db = db;
        _httpClientFactory = httpClientFactory;
        _signer = signer;
        _progressTokens = progressTokens;
        _liveSync = liveSync;
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
        // PV1 — detect a Hangfire retry: the previous attempt left the
        // row in Running/Phase != Queued before failing. Bump the
        // AttemptNumber via the domain method + publish so the UI
        // surfaces "Erneuter Versuch N/3" and so late callbacks from the
        // previous attempt get rejected by UpdateProgress's stale-attempt
        // guard.
        if (import.Status == ImportStatus.Running
            && import.Phase != RecipeImportPhase.Queued
            && import.Phase is not RecipeImportPhase.Done and not RecipeImportPhase.Error)
        {
            import.StartAttempt(import.AttemptNumber + 1, _clock.GetUtcNow());
            await _db.SaveChangesAsync(ct);
            await _liveSync.RecipeImportProgressChangedAsync(import, ct);
        }

        // PV1 — transition into the first "real work" phase. URL imports
        // start downloading; photo imports jump straight to Azure Vision
        // because there's no download step on that path. `MarkRunning`
        // keeps ImportStatus in sync for the existing polling surface.
        var entryPhase = import.Source == ImportSource.Photos
            ? RecipeImportPhase.VisionAnalysis
            : RecipeImportPhase.Downloading;
        import.MarkRunning(PhaseWeightedFormula.StartOf(entryPhase));
        import.UpdateProgress(
            phase: entryPhase,
            phaseProgress: 0,
            bytesDownloaded: null,
            bytesTotal: null,
            segmentsDone: null,
            segmentsTotal: null,
            attempt: import.AttemptNumber,
            now: _clock.GetUtcNow());
        await _db.SaveChangesAsync(ct);
        await _liveSync.RecipeImportProgressChangedAsync(import, ct);

        // PV2 hotfix — merge the progress-callback envelope into the
        // outbound body so Python's ProgressReporter can phone home with
        // per-phase progress. Without these four fields Python falls back
        // to NullProgressReporter and the UI sits at Queued(5%) for the
        // full 1-3 min extraction before the sync response lands at 100%.
        var now = _clock.GetUtcNow();
        var expiresAt = now + ImportProgressTokenService.MaxTokenLifetime;
        var callbackToken = _progressTokens.Sign(import.Id, expiresAt);
        var callbackBaseUrl = Environment.GetEnvironmentVariable(CallbackBaseUrlEnvVar)
            ?? DefaultCallbackBaseUrl;
        var callbackUrl = $"{callbackBaseUrl.TrimEnd('/')}/api/internal/imports/{import.Id:D}/progress";

        var bodyNode = JsonSerializer.SerializeToNode(buildBody(import))?.AsObject()
            ?? throw new InvalidOperationException(
                "buildBody returned a null or non-object payload; cannot attach progress callbacks.");
        bodyNode["callback_url"] = callbackUrl;
        bodyNode["callback_token"] = callbackToken;
        bodyNode["import_id"] = import.Id.ToString("D");
        bodyNode["attempt"] = import.AttemptNumber;

        var client = _httpClientFactory.CreateClient(ExtractRecipeFromUrlJob.HttpClientName);
        using var request = new HttpRequestMessage(HttpMethod.Post, relativeUrl)
        {
            Content = JsonContent.Create<JsonNode>(bodyNode),
        };
        await _signer.ApplyAsync(request, import.UserId, ct);

        // LANG-1 — forward the caller's UI language so the Python
        // extractor's FastAPI dependency picks it up and feeds it into
        // the system-prompt directive. Pre-LANG-1 import rows have no
        // value and fall back to "en" (matches REL-3h).
        var languageHeader = string.IsNullOrWhiteSpace(import.RequestedLanguage)
            ? LanguageNormalizer.DefaultLanguage
            : import.RequestedLanguage;
        request.Headers.TryAddWithoutValidation("Accept-Language", languageHeader);

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
                // Transition into the server-side post-processing phase
                // (persist result, thumbnails, revisions). Published so
                // the UI's progress bar jumps out of the long-running
                // phase and into "Nachverarbeitung..." the moment Python
                // returns.
                import.MarkRunning(PhaseWeightedFormula.StartOf(RecipeImportPhase.PostProcessing));
                import.UpdateProgress(
                    phase: RecipeImportPhase.PostProcessing,
                    phaseProgress: 0,
                    bytesDownloaded: null,
                    bytesTotal: null,
                    segmentsDone: null,
                    segmentsTotal: null,
                    attempt: import.AttemptNumber,
                    now: _clock.GetUtcNow());
                await _db.SaveChangesAsync(ct);
                await _liveSync.RecipeImportProgressChangedAsync(import, ct);

                var json = ValidateJsonOrThrow(bodyText);

                // Pull token-usage headers + record them on the import
                // *before* MarkDone transitions to terminal state.
                // Headers absent (e.g. mock provider, older Python
                // build) → skip silently; a null-usage row is
                // acceptable and just hides from the admin dashboard.
                if (UsageHeaders.TryRead(response, out var prompt, out var completion,
                        out var cached, out var model))
                {
                    import.RecordUsage(prompt, completion, cached, model);
                }

                import.MarkDone(json, _clock.GetUtcNow());
                await _db.SaveChangesAsync(ct);
                await _liveSync.RecipeImportProgressChangedAsync(import, ct);
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
                await _liveSync.RecipeImportProgressChangedAsync(import, ct);
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
