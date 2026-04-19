using System.Security.Claims;
using FamilienKochbuch.Api.Hubs;
using FamilienKochbuch.Api.Jobs;
using FamilienKochbuch.Api.Services;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Infrastructure.Persistence;
using Hangfire;
using Microsoft.EntityFrameworkCore;

namespace FamilienKochbuch.Api.Endpoints;

/// <summary>
/// Endpoints for the <see cref="RecipeImport"/> aggregate.
///
/// <list type="bullet">
/// <item><c>GET /api/imports/{importId}</c> — P2-5 status endpoint the
/// frontend polls every 2 s.</item>
/// <item><c>POST /api/recipes/import/url</c> — P2-6 step 1. Enqueue a
/// URL-based recipe extraction job.</item>
/// <item><c>POST /api/recipes/import/photos</c> — P2-6 step 2. Enqueue
/// a photo-based extraction job.</item>
/// </list>
///
/// The two enqueue endpoints share this file with the status read
/// because they all pivot around <see cref="RecipeImport"/>; splitting
/// them out would scatter the aggregate's HTTP surface across three
/// files with near-zero reuse.
/// </summary>
public static class ImportEndpoints
{
    /// <summary>
    /// Wire shape of <c>GET /api/imports/{importId}</c>. PV4 extends the
    /// original P2-5 subset (Id/Source/Status/Progress/… only) with the
    /// full phase-tracking snapshot so the polling-fallback path (used
    /// when SignalR is disconnected or the tab was backgrounded across
    /// a reconnect) gives the frontend the same information the SignalR
    /// event would have delivered. <see cref="GroupId"/> in particular
    /// resolves BUG-012: the frontend auto-redirect on Done needs the
    /// target group and previously depended on navigation-state /
    /// sessionStorage, which are fragile across reloads and new tabs.
    ///
    /// <see cref="Phase"/> is serialised as the lower-case / snake-case
    /// wire form (e.g. <c>"post_processing"</c>) so it matches the
    /// SignalR <c>RecipeImportProgressChanged</c> payload, the Python
    /// callback shape, and the frontend's <c>RecipeImportPhase</c>
    /// union — one wire vocabulary across all three surfaces.
    /// </summary>
    public record ImportStatusResponse(
        Guid Id,
        Guid GroupId,
        string Source,
        string Status,
        int Progress,
        string? SourceUrl,
        string? Result,
        string? Error,
        DateTimeOffset CreatedAt,
        DateTimeOffset? CompletedAt,
        string Phase,
        int PhaseProgress,
        string? ProgressLabel,
        int AttemptNumber,
        long? BytesDownloaded,
        long? BytesTotal,
        int? SegmentsDone,
        int? SegmentsTotal,
        DateTimeOffset LastProgressAt);

    /// <summary>Body of <c>POST /api/recipes/import/url</c>.</summary>
    public record UrlImportRequest(string Url, Guid GroupId);

    /// <summary>Body of <c>POST /api/recipes/import/photos</c>.</summary>
    public record PhotoImportRequest(string[] PhotoUrls, Guid GroupId);

    /// <summary>Response of enqueue endpoints.</summary>
    public record ImportEnqueueResponse(Guid ImportId);

    /// <summary>Hard cap on photo batch size per import.
    /// Matches the Python pipeline's cap + plan §2.</summary>
    public const int MaxPhotosPerImport = 10;

    public static void MapImportEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/api/imports").WithTags("Imports");
        group.MapGet("/{importId:guid}", GetImportAsync).RequireAuthorization();

        // P2-6 step 1 + 2 — user-facing enqueue endpoints under
        // /api/recipes/import. Mounted separately from /api/imports
        // because the route belongs with the "recipes" surface area in
        // the frontend's mental model ("I import a recipe") even though
        // it writes a RecipeImport.
        var enqueue = app.MapGroup("/api/recipes/import").WithTags("Imports");
        enqueue.MapPost("/url", EnqueueUrlImportAsync).RequireAuthorization();
        enqueue.MapPost("/photos", EnqueuePhotoImportAsync).RequireAuthorization();
    }

    private static async Task<IResult> GetImportAsync(
        Guid importId,
        HttpContext ctx,
        AppDbContext db,
        CancellationToken ct)
    {
        var callerId = ctx.User.FindFirstValue(System.IdentityModel.Tokens.Jwt.JwtRegisteredClaimNames.Sub);
        if (string.IsNullOrWhiteSpace(callerId) || !Guid.TryParse(callerId, out var callerGuid))
            return Results.Unauthorized();

        var isAdmin = string.Equals(
            ctx.User.FindFirstValue(AdminOnlyAuthorizationFilter.RoleClaimType),
            AdminOnlyAuthorizationFilter.AdminRoleClaimValue,
            StringComparison.Ordinal);

        var import = await db.RecipeImports.AsNoTracking()
            .SingleOrDefaultAsync(i => i.Id == importId, ct);
        if (import is null)
            return Results.NotFound();

        if (!isAdmin && import.UserId != callerGuid)
            return FamilienResults.Forbidden("forbidden", "Dieser Import gehört dir nicht.");

        return Results.Ok(new ImportStatusResponse(
            Id: import.Id,
            GroupId: import.GroupId,
            Source: import.Source.ToString(),
            Status: import.Status.ToString(),
            Progress: import.Progress,
            SourceUrl: import.SourceUrl,
            // ResultJson is surfaced only on Done (the enqueue side
            // uses ResultJson for transit data on Photos jobs; don't
            // leak that raw back to the caller while still running).
            Result: import.Status == ImportStatus.Done ? import.ResultJson : null,
            Error: import.ErrorMessage,
            CreatedAt: import.CreatedAt,
            CompletedAt: import.CompletedAt,
            // PV4 — phase-tracking snapshot. Phase goes through the same
            // snake-case mapper the SignalR publisher + Python callback
            // use, so the three transports serialise identically.
            Phase: RecipeImportPhaseWire.ToWire(import.Phase),
            PhaseProgress: import.PhaseProgress,
            ProgressLabel: import.ProgressLabel,
            AttemptNumber: import.AttemptNumber,
            BytesDownloaded: import.BytesDownloaded,
            BytesTotal: import.BytesTotal,
            SegmentsDone: import.SegmentsDone,
            SegmentsTotal: import.SegmentsTotal,
            LastProgressAt: import.LastProgressAt));
    }

    // ── POST /api/recipes/import/url ─────────────────────────────────

    /// <summary>
    /// Creates a <see cref="RecipeImport"/> row in <c>Queued</c> state
    /// and enqueues <see cref="ExtractRecipeFromUrlJob"/> to drive the
    /// Python pipeline. Returns <c>202 Accepted</c> with the new
    /// import id so the frontend can start polling the status endpoint.
    ///
    /// Validation order (cheapest first):
    /// <list type="number">
    /// <item>Auth — caller must have a sub claim.</item>
    /// <item>URL shape — absolute http(s) only. A hostile or
    /// non-http scheme is rejected 400 with a German reason.</item>
    /// <item>Group existence — 404 when the group is gone /
    /// soft-deleted.</item>
    /// <item>Group membership — 403 when the caller is not a member.
    /// Intentionally distinct from 404 so the UI can show the right
    /// message ("Du bist in dieser Gruppe nicht Mitglied.")</item>
    /// </list>
    /// </summary>
    private static async Task<IResult> EnqueueUrlImportAsync(
        UrlImportRequest body,
        HttpContext ctx,
        AppDbContext db,
        IBackgroundJobClient jobs,
        TimeProvider clock,
        CancellationToken ct)
    {
        if (!TryGetCallerId(ctx, out var callerId))
            return Results.Unauthorized();

        if (!TryNormalizeHttpUrl(body?.Url, out var normalizedUrl))
            return FamilienResults.BadRequest(
                "invalid_url",
                "Die URL muss absolut sein und mit http:// oder https:// beginnen.");

        if (body!.GroupId == Guid.Empty)
            return FamilienResults.BadRequest(
                "invalid_group",
                "Die Gruppen-ID fehlt oder ist ungültig.");

        var group = await db.Groups
            .SingleOrDefaultAsync(g => g.Id == body.GroupId && g.DeletedAt == null, ct);
        if (group is null)
            return FamilienResults.NotFound(
                "group_not_found",
                "Die angegebene Gruppe wurde nicht gefunden.");

        var isMember = await db.GroupMemberships
            .AnyAsync(m => m.GroupId == body.GroupId && m.UserId == callerId, ct);
        if (!isMember)
            return FamilienResults.Forbidden(
                "not_a_member",
                "Du bist in dieser Gruppe nicht Mitglied.");

        var import = new RecipeImport(
            userId: callerId,
            groupId: body.GroupId,
            source: ImportSource.Url,
            sourceUrl: normalizedUrl,
            createdAt: clock.GetUtcNow());
        db.RecipeImports.Add(import);
        await db.SaveChangesAsync(ct);

        // Fire-and-forget — Hangfire picks it up from the queue. The
        // endpoint never waits on the Python call; the frontend polls
        // the status endpoint to observe progress.
        jobs.Enqueue<ExtractRecipeFromUrlJob>(j =>
            j.ExecuteAsync(import.Id, CancellationToken.None));

        return Results.Accepted(
            $"/api/imports/{import.Id}",
            new ImportEnqueueResponse(import.Id));
    }

    // ── POST /api/recipes/import/photos ──────────────────────────────

    /// <summary>
    /// Creates a <see cref="RecipeImport"/> of type <c>Photos</c> in
    /// <c>Queued</c> state and enqueues
    /// <see cref="ExtractRecipeFromPhotosJob"/>. The ordered photo URL
    /// list is stashed in <see cref="RecipeImport.ResultJson"/> as a
    /// JSON array — the job reads it out before calling Python (this
    /// is the transit contract the P2-5 job already expects).
    ///
    /// Validation order:
    /// <list type="number">
    /// <item>Auth.</item>
    /// <item>Photo count: 1..<see cref="MaxPhotosPerImport"/>.</item>
    /// <item>Group existence (404) / membership (403).</item>
    /// <item>Each photo URL must carry a valid signature from
    /// <see cref="ImageSigningService"/>. That proves the caller has
    /// seen it through an authenticated response at some point in the
    /// last validity window (default 2 h) — i.e. they "own" it.</item>
    /// </list>
    /// </summary>
    private static async Task<IResult> EnqueuePhotoImportAsync(
        PhotoImportRequest body,
        HttpContext ctx,
        AppDbContext db,
        ImageSigningService signing,
        IBackgroundJobClient jobs,
        TimeProvider clock,
        CancellationToken ct)
    {
        if (!TryGetCallerId(ctx, out var callerId))
            return Results.Unauthorized();

        var photoUrls = body?.PhotoUrls ?? Array.Empty<string>();
        if (photoUrls.Length == 0)
            return FamilienResults.BadRequest(
                "photos_required",
                "Es muss mindestens ein Foto übermittelt werden.");
        if (photoUrls.Length > MaxPhotosPerImport)
            return FamilienResults.BadRequest(
                "too_many_photos",
                $"Maximal {MaxPhotosPerImport} Fotos pro Import.");

        if (body!.GroupId == Guid.Empty)
            return FamilienResults.BadRequest(
                "invalid_group",
                "Die Gruppen-ID fehlt oder ist ungültig.");

        var group = await db.Groups
            .SingleOrDefaultAsync(g => g.Id == body.GroupId && g.DeletedAt == null, ct);
        if (group is null)
            return FamilienResults.NotFound(
                "group_not_found",
                "Die angegebene Gruppe wurde nicht gefunden.");

        var isMember = await db.GroupMemberships
            .AnyAsync(m => m.GroupId == body.GroupId && m.UserId == callerId, ct);
        if (!isMember)
            return FamilienResults.Forbidden(
                "not_a_member",
                "Du bist in dieser Gruppe nicht Mitglied.");

        // Each URL must round-trip through the signed-URL verifier.
        // Reject the whole batch on the first bad one — a frontend bug
        // that sends one unsigned URL is a bug worth surfacing clearly,
        // not silently dropping.
        foreach (var url in photoUrls)
        {
            if (!IsSignedPhotoUrl(url, signing))
                return FamilienResults.BadRequest(
                    "invalid_photo_url",
                    "Mindestens ein Foto wurde nicht über die offizielle Upload-Route bereitgestellt.");
        }

        var import = new RecipeImport(
            userId: callerId,
            groupId: body.GroupId,
            source: ImportSource.Photos,
            sourceUrl: null,
            createdAt: clock.GetUtcNow());

        // Stash the ordered URL list in ResultJson for the job to read.
        // MarkRunning clears nothing, and the job itself overwrites
        // ResultJson on completion, so the transit payload doesn't leak
        // back to the caller via GET /api/imports/{id} (which only
        // surfaces Result when Status == Done).
        var transitPayload = System.Text.Json.JsonSerializer.Serialize(photoUrls);
        import.StageTransitPayload(transitPayload);

        db.RecipeImports.Add(import);
        await db.SaveChangesAsync(ct);

        jobs.Enqueue<ExtractRecipeFromPhotosJob>(j =>
            j.ExecuteAsync(import.Id, CancellationToken.None));

        return Results.Accepted(
            $"/api/imports/{import.Id}",
            new ImportEnqueueResponse(import.Id));
    }

    // ── Shared helpers ──────────────────────────────────────────────

    /// <summary>Extracts the caller's user id from the JWT's <c>sub</c>
    /// claim. Returns false if missing or not a Guid.</summary>
    private static bool TryGetCallerId(HttpContext ctx, out Guid callerId)
    {
        callerId = Guid.Empty;
        var sub = ctx.User.FindFirstValue(
            System.IdentityModel.Tokens.Jwt.JwtRegisteredClaimNames.Sub);
        return !string.IsNullOrWhiteSpace(sub) && Guid.TryParse(sub, out callerId);
    }

    /// <summary>
    /// Validates + normalises a user-supplied recipe URL. Accepts only
    /// absolute <c>http(s)</c> URIs; rejects empty / relative /
    /// non-http schemes. On success, <paramref name="normalized"/> is
    /// the trimmed original string (Python is the source of truth for
    /// URL normalisation — we don't rewrite it here).
    /// </summary>
    private static bool TryNormalizeHttpUrl(string? raw, out string normalized)
    {
        normalized = string.Empty;
        if (string.IsNullOrWhiteSpace(raw)) return false;
        var trimmed = raw.Trim();
        if (!Uri.TryCreate(trimmed, UriKind.Absolute, out var uri)) return false;
        if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
            return false;
        normalized = trimmed;
        return true;
    }

    /// <summary>
    /// Returns true iff <paramref name="raw"/> is a signed photo URL
    /// whose <c>sig</c>+<c>exp</c> query parameters verify against
    /// <see cref="ImageSigningService"/> for the encoded path. Accepts
    /// both relative (<c>/api/photos/…</c>) and absolute URLs.
    ///
    /// The signature is scoped to <c>{path}:{exp}</c> (no user id) —
    /// ownership in this API is "the caller must have been handed this
    /// URL by an authenticated endpoint at some point in the last
    /// validity window", which is what the signed-URL scheme already
    /// enforces end-to-end.
    /// </summary>
    private static bool IsSignedPhotoUrl(string? raw, ImageSigningService signing)
    {
        if (string.IsNullOrWhiteSpace(raw)) return false;

        // Accept both relative and absolute shapes. Parse the absolute
        // case only when the scheme is http[s] — .NET's URI parser
        // otherwise interprets leading-slash paths as file:// URIs and
        // mangles the ? into %3F on PathAndQuery.
        string pathAndQuery;
        if (Uri.TryCreate(raw, UriKind.Absolute, out var abs)
            && (abs.Scheme == Uri.UriSchemeHttp || abs.Scheme == Uri.UriSchemeHttps))
        {
            pathAndQuery = abs.PathAndQuery;
        }
        else if (raw!.StartsWith('/'))
        {
            // Relative path-absolute ("/api/photos/...") — use verbatim.
            pathAndQuery = raw;
        }
        else
        {
            return false;
        }

        var qIdx = pathAndQuery.IndexOf('?');
        if (qIdx < 0) return false;

        var path = pathAndQuery[..qIdx];
        var query = pathAndQuery[qIdx..]; // keep the leading '?'

        // Strip the /api/photos/ public prefix — that's the part the
        // signer keys off.
        const string prefix = "/api/photos/";
        if (!path.StartsWith(prefix, StringComparison.Ordinal)) return false;
        var filePath = path[prefix.Length..];
        if (string.IsNullOrWhiteSpace(filePath)) return false;

        // Use ASP.NET Core's parser — it URL-decodes percent-escapes
        // but leaves the url-safe-base64 alphabet alone. System.Web's
        // parser turns '+' into ' ', which would only matter on
        // standard base64 anyway — our signer uses url-safe base64 so
        // either parser would work today, but QueryHelpers is the
        // canonical one for request-query parsing on this stack.
        var parsed = Microsoft.AspNetCore.WebUtilities.QueryHelpers.ParseQuery(query);
        if (!parsed.TryGetValue("sig", out var sigValues)
            || !parsed.TryGetValue("exp", out var expValues))
        {
            return false;
        }
        var sig = sigValues.ToString();
        if (string.IsNullOrWhiteSpace(sig)
            || !long.TryParse(expValues.ToString(),
                System.Globalization.NumberStyles.Integer,
                System.Globalization.CultureInfo.InvariantCulture,
                out var exp))
        {
            return false;
        }
        return signing.Validate(filePath, sig, exp);
    }
}
