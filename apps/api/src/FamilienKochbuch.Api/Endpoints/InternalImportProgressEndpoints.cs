using System.Text.Json.Serialization;
using FamilienKochbuch.Api.Hubs;
using FamilienKochbuch.Api.Services;
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
/// or <c>phase_progress</c> is out of [0, 100], or <c>attempt</c> &lt; 1.</item>
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
            .RequireRateLimiting(RateLimitPolicies.ImportProgress);
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
        if (body.Attempt is null || body.Attempt.Value < 1)
            return ValidationProblem(
                "Das Feld 'attempt' fehlt oder ist kleiner als 1.", "attempt_invalid");
        if (body.PhaseProgress is null || body.PhaseProgress is < 0 or > 100)
            return ValidationProblem(
                "Das Feld 'phase_progress' muss zwischen 0 und 100 liegen.", "phase_progress_invalid");
        if (!RecipeImportPhaseWire.TryParse(body.Phase, out var phase))
            return ValidationProblem(
                $"Das Feld 'phase' '{body.Phase}' ist kein gültiger Phasen-Wert.",
                "phase_invalid");
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
