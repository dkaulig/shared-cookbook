using System.Text.Json.Serialization;
using FamilienKochbuch.Api.Hubs;
using FamilienKochbuch.Api.Services;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.Enums;
using FamilienKochbuch.Infrastructure.Persistence;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace FamilienKochbuch.Api.Endpoints;

/// <summary>
/// PV1 — internal-only progress callback endpoint the Python extractor
/// posts phase+percentage updates to.
///
/// <list type="bullet">
/// <item>Route: <c>POST /api/internal/imports/{importId:guid}/progress</c></item>
/// <item>Auth: <c>Authorization: Bearer &lt;per-import HMAC token&gt;</c> — scoped
/// to the <c>importId</c> in the URL; 10-minute TTL; rotates every retry.</item>
/// <item>Network boundary: Caddy refuses external origins with 404 before
/// they hit Kestrel; <see cref="InternalOnlyMiddleware"/> mirrors the 404
/// inside the app for defence-in-depth.</item>
/// <item>Rate limit: 500 / minute per <c>importId</c> — see
/// <c>RateLimitPolicies.ImportProgress</c>.</item>
/// </list>
///
/// Responses:
/// <list type="bullet">
/// <item><c>204</c> — update applied (or idempotently discarded by the
/// domain guards — out-of-order / stale-attempt callbacks still
/// return 204 so the Python reporter's fire-and-forget loop doesn't
/// spin on transient "errors").</item>
/// <item><c>401</c> — bad/expired/cross-import HMAC token.</item>
/// <item><c>404</c> — <c>importId</c> unknown.</item>
/// <item><c>422</c> — <c>phase</c> is not one of the accepted wire values,
/// <c>phase</c> is a terminal state (<c>done</c> / <c>error</c> —
/// callbacks MUST NOT drive terminal transitions; those come from
/// <see cref="RecipeImport.MarkDone"/> / <see cref="RecipeImport.MarkError"/>
/// in the Hangfire job), <c>phase_progress</c> is out of [0, 100], or
/// <c>attempt</c> is out of [1, <see cref="MaxAttempt"/>].</item>
/// <item><c>429</c> — rate-limit burst (handled by the rate-limiter
/// middleware automatically).</item>
/// </list>
/// </summary>
public static class InternalImportProgressEndpoints
{
    /// <summary>Authorization header scheme the Python reporter sends.
    /// Constant so middleware + tests agree on casing.</summary>
    public const string BearerScheme = "Bearer";

    /// <summary>
    /// PV1 security — upper bound on the <c>attempt</c> field accepted
    /// from the wire. Matches the Hangfire <c>[AutomaticRetry]</c>
    /// budget (3 retries total); a callback claiming attempt &gt; 3 is
    /// either a mis-wired reporter or a forged-future replay by an
    /// attacker trying to wedge the monotonic phase guard permanently
    /// ahead of legitimate updates. Rejected with 422.
    /// </summary>
    public const int MaxAttempt = 3;

    /// <summary>
    /// PV1 security — body-size cap on the callback endpoint. The
    /// payload is a ~200-byte JSON object (phase, two ints, optional
    /// byte/segment counters); 4 KB is generous headroom. Cap prevents
    /// an attacker with a valid token from tying up the JSON parser
    /// with megabytes of garbage (default Kestrel is ~30 MB). Mirrors
    /// the P3-3 pattern on the PATCH slot endpoint.
    /// </summary>
    public const long BodySizeLimitBytes = 4_096;

    /// <summary>
    /// Wire shape of the callback body — snake_case to match the Python
    /// reporter's JSON output (FastAPI/pydantic convention). The record
    /// is nullable-everywhere so a malformed body falls to the 422 branch
    /// rather than throwing during model binding.
    /// </summary>
    public sealed record ImportProgressPayload(
        [property: JsonPropertyName("phase")] string? Phase,
        [property: JsonPropertyName("phase_progress")] int? PhaseProgress,
        [property: JsonPropertyName("bytes_done")] long? BytesDone,
        [property: JsonPropertyName("bytes_total")] long? BytesTotal,
        [property: JsonPropertyName("segments_done")] int? SegmentsDone,
        [property: JsonPropertyName("segments_total")] int? SegmentsTotal,
        [property: JsonPropertyName("attempt")] int? Attempt);

    public static void MapInternalImportProgressEndpoints(this WebApplication app)
    {
        // Deliberately NO .RequireAuthorization(): the JWT bearer scheme
        // is the user-session auth, which Python doesn't have. We own
        // the auth for this route via the per-import HMAC token.
        var group = app.MapGroup("/api/internal/imports")
            .WithTags("InternalImports");

        group.MapPost("/{importId:guid}/progress", PostProgressAsync)
            // PV1 security — two-layered rate limit:
            //   Layer A (per-importId, 500/min): the named policy
            //   below. One flooding import can't starve concurrent
            //   imports' callbacks.
            //   Layer B (global, 10_000/min): applied via
            //   options.GlobalLimiter in Program.cs for every
            //   /api/internal/* request. Stops a GUID-spray DoS from
            //   growing the per-importId partition population
            //   unbounded.
            // Both layers fail the request independently (the global
            // pipe runs first; if it 429s, the per-importId policy
            // never sees the request).
            .RequireRateLimiting(RateLimitPolicies.ImportProgress)
            // PV1 security — cap body size at 4 KB (payload is ~200 B).
            .WithMetadata(new RequestSizeLimitAttribute(BodySizeLimitBytes));
    }

    private static async Task<IResult> PostProgressAsync(
        Guid importId,
        [FromBody] ImportProgressPayload? body,
        HttpContext ctx,
        AppDbContext db,
        ImportProgressTokenService tokens,
        ILiveSyncPublisher liveSync,
        TimeProvider clock,
        ILoggerFactory loggerFactory,
        CancellationToken ct)
    {
        var logger = loggerFactory.CreateLogger("InternalImportProgressEndpoint");

        // ── Auth ──
        if (!TryReadBearer(ctx, out var token))
        {
            // No Authorization header / wrong scheme — 401.
            return Results.Unauthorized();
        }
        if (!tokens.TryVerify(token, importId, clock.GetUtcNow(), out var failure))
        {
            logger.LogWarning(
                "Rejected /api/internal/imports/{ImportId}/progress — token invalid ({Reason}).",
                importId, failure);
            return Results.Unauthorized();
        }

        // ── Payload validation ──
        if (body is null)
            return ValidationProblem(
                "Der Request-Body fehlt oder ist leer.", "body_missing");
        // PV1 security — bound the attempt field to [1, MaxAttempt] so
        // a compromised / forged callback cannot wedge the monotonic
        // phase guard permanently ahead of legitimate updates by
        // claiming attempt=999 in a forged future.
        if (body.Attempt is null || body.Attempt.Value < 1 || body.Attempt.Value > MaxAttempt)
            return ValidationProblem(
                $"Das Feld 'attempt' muss zwischen 1 und {MaxAttempt} liegen.",
                "attempt.out_of_range");
        if (body.PhaseProgress is null || body.PhaseProgress is < 0 or > 100)
            return ValidationProblem(
                "Das Feld 'phase_progress' muss zwischen 0 und 100 liegen.", "phase_progress_invalid");
        if (!RecipeImportPhaseWire.TryParse(body.Phase, out var phase))
            return ValidationProblem(
                $"Das Feld 'phase' '{body.Phase}' ist kein gültiger Phasen-Wert.",
                "phase_invalid");
        // PV1 security — reject terminal phases on the progress
        // callback. Terminal transitions (Done / Error) are owned by
        // MarkDone / MarkError invoked from the Hangfire job; allowing
        // them here would let a compromised python-extractor (or an
        // attacker who stole a valid token) flip the import to Done
        // without actually persisting a recipe, leaving the user with
        // a "Fertig" banner and an empty cookbook. Domain-level
        // UpdateProgress ALSO rejects these values as defence-in-depth,
        // but the endpoint returns a louder 422 so a mis-wired reporter
        // gets a clear signal instead of a silent 204 no-op.
        if (phase is RecipeImportPhase.Done or RecipeImportPhase.Error)
            return ValidationProblem(
                "Das Feld 'phase' darf keinen terminalen Zustand ('done' / 'error') tragen.",
                "phase.illegal_terminal_state");
        if (body.BytesDownloaded() is long bd && bd < 0)
            return ValidationProblem(
                "Das Feld 'bytes_done' darf nicht negativ sein.", "bytes_done_invalid");
        if (body.BytesTotal is long bt && bt < 0)
            return ValidationProblem(
                "Das Feld 'bytes_total' darf nicht negativ sein.", "bytes_total_invalid");
        if (body.SegmentsDone is int sd && sd < 0)
            return ValidationProblem(
                "Das Feld 'segments_done' darf nicht negativ sein.", "segments_done_invalid");
        if (body.SegmentsTotal is int st && st < 0)
            return ValidationProblem(
                "Das Feld 'segments_total' darf nicht negativ sein.", "segments_total_invalid");

        // ── Load import ──
        var import = await db.RecipeImports.SingleOrDefaultAsync(i => i.Id == importId, ct);
        if (import is null)
        {
            // Token was valid (HMAC checked out) but the row is gone —
            // race with an admin delete. 404.
            return Results.NotFound();
        }

        // ── Apply update ──
        var accepted = import.UpdateProgress(
            phase: phase,
            phaseProgress: body.PhaseProgress.Value,
            bytesDownloaded: body.BytesDownloaded(),
            bytesTotal: body.BytesTotal,
            segmentsDone: body.SegmentsDone,
            segmentsTotal: body.SegmentsTotal,
            attempt: body.Attempt.Value,
            now: clock.GetUtcNow());

        if (accepted)
        {
            await db.SaveChangesAsync(ct);
            await liveSync.RecipeImportProgressChangedAsync(import, ct);
        }
        else
        {
            // Idempotent no-op — domain rejected silently (out-of-order,
            // stale attempt, or terminal state). Still 204: the Python
            // reporter is fire-and-forget and shouldn't spin on a
            // server-side "yeah, got that already" signal.
            logger.LogDebug(
                "Progress update idempotently discarded for {ImportId} (current phase={CurrentPhase}/{CurrentProgress}, "
                + "incoming phase={IncomingPhase}/{IncomingProgress}, attempt={Attempt} vs current {CurrentAttempt}).",
                importId,
                import.Phase,
                import.PhaseProgress,
                phase,
                body.PhaseProgress,
                body.Attempt,
                import.AttemptNumber);
        }

        return Results.NoContent();
    }

    // ── Helpers ────────────────────────────────────────────────────────

    private static bool TryReadBearer(HttpContext ctx, out string token)
    {
        token = string.Empty;
        if (!ctx.Request.Headers.TryGetValue("Authorization", out var values))
            return false;
        var header = values.ToString();
        if (string.IsNullOrWhiteSpace(header)) return false;
        var space = header.IndexOf(' ');
        if (space <= 0) return false;
        var scheme = header[..space];
        if (!string.Equals(scheme, BearerScheme, StringComparison.OrdinalIgnoreCase))
            return false;
        var rest = header[(space + 1)..].Trim();
        if (string.IsNullOrWhiteSpace(rest)) return false;
        token = rest;
        return true;
    }

    private static IResult ValidationProblem(string detail, string code)
    {
        // 422 Unprocessable Entity — the body parsed as JSON but failed
        // our domain validation. Consistent with FastAPI's 422 behaviour
        // on the Python side so error-handling code is symmetrical.
        return Results.Json(
            new { code, message = detail },
            statusCode: StatusCodes.Status422UnprocessableEntity);
    }
}

internal static class ImportProgressPayloadExtensions
{
    /// <summary>Alias the wire name (<c>bytes_done</c>) to the domain
    /// verb (<c>BytesDownloaded</c>) so the endpoint code reads
    /// naturally.</summary>
    public static long? BytesDownloaded(this InternalImportProgressEndpoints.ImportProgressPayload p)
        => p.BytesDone;
}
