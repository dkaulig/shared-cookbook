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
/// <item><c>GET /api/imports?mine=true&amp;limit=20</c> — BUG-010 list
/// endpoint: the caller's most-recent imports across every group they
/// are a member of. Used by <c>ImportListPage</c> to show a dashboard
/// of running / completed / errored imports.</item>
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
        DateTimeOffset LastProgressAt,
        /// <summary>
        /// BUG-018 — id of the <see cref="StagedPhoto"/> the URL job
        /// downloaded from the extracted video thumbnail (yt-dlp frame).
        /// Null when the source had no thumbnail or the download fell
        /// back to the graceful-failure path (timeout, oversize,
        /// non-image, host-allowlist reject). The frontend's import
        /// prefill auto-adds this id to the staged-photo list it
        /// forwards to <c>POST /api/recipes</c>, so the user gets the
        /// thumbnail attached as a recipe photo without manual upload.
        /// </summary>
        Guid? ThumbnailStagedPhotoId);

    /// <summary>
    /// Wire shape of <c>GET /api/imports?mine=true</c>. Lighter than
    /// <see cref="ImportStatusResponse"/> — no <c>Result</c> field (the
    /// list view never surfaces the extracted recipe payload), no
    /// transit-only fields (bytes / segments live on the detail view).
    ///
    /// Kept deliberately close to the shape the list UI needs so the
    /// wire doesn't leak the internal transit data (photo URLs stashed
    /// in <c>ResultJson</c>) and so the endpoint can render a snapshot
    /// without extra projections. <see cref="Phase"/> uses the
    /// snake-case wire form consistent with
    /// <see cref="ImportStatusResponse"/>.
    /// </summary>
    public record ImportSummary(
        Guid Id,
        Guid GroupId,
        string Source,
        string Status,
        int Progress,
        string Phase,
        string? ProgressLabel,
        string? SourceUrl,
        DateTimeOffset CreatedAt,
        DateTimeOffset? CompletedAt,
        string? Error);

    /// <summary>Default cap for <c>GET /api/imports?mine=true</c>. Matches
    /// the frontend's v1 page size so callers get a useful snapshot
    /// without tuning.</summary>
    public const int DefaultMineImportsLimit = 20;

    /// <summary>Hard ceiling for the <c>limit</c> query parameter on
    /// <c>GET /api/imports?mine=true</c>. A hostile / misconfigured
    /// caller cannot drain the entire imports table from a single
    /// request — beyond this we clamp silently.</summary>
    public const int MaxMineImportsLimit = 100;

    /// <summary>
    /// Body of <c>POST /api/recipes/import/url</c>.
    ///
    /// BUG-013 — <see cref="Force"/> (default <c>false</c>) is the
    /// opt-out for the per-user 7-day import-cache: setting it to
    /// <c>true</c> skips the pre-enqueue lookup so the pipeline re-runs
    /// even when a recent successful import exists for the same URL.
    /// The frontend surfaces this as a "Neu extrahieren"-button on the
    /// cache-hit banner.
    /// </summary>
    public record UrlImportRequest(string Url, Guid GroupId, bool Force = false);

    /// <summary>Body of <c>POST /api/recipes/import/photos</c>.</summary>
    public record PhotoImportRequest(string[] PhotoUrls, Guid GroupId);

    /// <summary>
    /// Response of enqueue endpoints.
    ///
    /// BUG-013 — <see cref="Cached"/> is <c>true</c> when the URL-import
    /// endpoint short-circuited to an existing successful import for the
    /// same caller + same canonical URL within
    /// <see cref="UrlImportCacheTtl"/>. The pipeline was NOT re-run; the
    /// returned <see cref="ImportId"/> points at the cached row whose
    /// <c>ResultJson</c> already carries the extracted recipe. Defaults
    /// to <c>false</c> so existing tests that deserialise without the
    /// field see the old contract verbatim.
    /// </summary>
    public record ImportEnqueueResponse(Guid ImportId)
    {
        public bool Cached { get; init; } = false;
    }

    /// <summary>
    /// BUG-013 — cache TTL for the URL-import short-circuit. A URL
    /// re-imported within this window returns the existing result
    /// instead of re-running the whole pipeline. 7 days is short
    /// enough that prompt/model improvements propagate on a reasonable
    /// cadence, long enough that the reported "I pasted the link twice
    /// this week" flow hits consistently.
    /// </summary>
    public static readonly TimeSpan UrlImportCacheTtl = TimeSpan.FromDays(7);

    /// <summary>Hard cap on photo batch size per import.
    /// Matches the Python pipeline's cap + plan §2.</summary>
    public const int MaxPhotosPerImport = 10;

    public static void MapImportEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/api/imports").WithTags("Imports");
        group.MapGet("/{importId:guid}", GetImportAsync).RequireAuthorization();
        // BUG-010 — list snapshot. Distinct route-shape from the
        // per-id GET; Minimal-APIs route-matches by template before
        // hitting the `mine` query, so they coexist cleanly.
        group.MapGet("", ListMineImportsAsync).RequireAuthorization();

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
            LastProgressAt: import.LastProgressAt,
            // BUG-018 — surface the auto-attached video thumbnail
            // staged-photo id so the frontend prefill can promote it
            // alongside any user-uploaded photos without an extra round-trip.
            ThumbnailStagedPhotoId: import.ThumbnailStagedPhotoId));
    }

    // ── GET /api/imports?mine=true (BUG-010 list) ───────────────────

    /// <summary>
    /// Lists the caller's most-recent imports across every group they
    /// are a member of, newest first. Powers the BUG-010 "Imports"
    /// dashboard.
    ///
    /// Auth: same surface as the per-id GET — every row is owned by the
    /// caller (admin can see everyone's via <c>mine=false</c>, but the
    /// frontend only ever calls with <c>mine=true</c> for now).
    ///
    /// The <c>mine</c> flag is required to be <c>true</c> for now —
    /// surfacing "everybody's imports" without admin-gating would leak
    /// other users' source URLs. We accept the parameter explicitly so
    /// a future admin console can opt-out with a distinct code path
    /// rather than silently breaking the contract.
    ///
    /// The <c>limit</c> parameter is clamped to
    /// <see cref="MaxMineImportsLimit"/> so a crafted URL cannot pull
    /// the whole table in one request.
    /// </summary>
    private static async Task<IResult> ListMineImportsAsync(
        HttpContext ctx,
        AppDbContext db,
        CancellationToken ct,
        bool mine = true,
        int limit = DefaultMineImportsLimit)
    {
        if (!TryGetCallerId(ctx, out var callerId))
            return Results.Unauthorized();

        // Guardrails: `mine=false` is explicitly not supported on the
        // public surface. The admin dashboard uses its own queries, so
        // we reject here rather than silently turning a hostile caller
        // into "list everyone".
        if (!mine)
            return FamilienResults.BadRequest(
                "mine_required",
                "Nur eigene Imports können über diesen Endpoint abgerufen werden.");

        if (limit <= 0) limit = DefaultMineImportsLimit;
        if (limit > MaxMineImportsLimit) limit = MaxMineImportsLimit;

        // Imports the caller owns themselves (UserId match) restricted
        // to groups they are still a member of. In practice every import
        // already satisfies both predicates because the enqueue
        // endpoints reject non-members up front; the second clause
        // guards against a user being removed from a group after
        // submitting an import (stale rows should disappear from their
        // list view).
        //
        // SQLite (test provider) can't ORDER BY DateTimeOffset at the
        // SQL layer, so we materialise the filtered candidate set and
        // sort + cap in LINQ-to-Objects. The WHERE predicate still runs
        // server-side so the transferred row set is scoped to the
        // caller's imports only (practical bound: a single user has
        // far fewer imports than the admin-wide table).
        var rows = await db.RecipeImports.AsNoTracking()
            .Where(i => i.UserId == callerId
                && db.GroupMemberships.Any(m =>
                    m.GroupId == i.GroupId && m.UserId == callerId))
            .ToListAsync(ct);

        var summaries = rows
            .OrderByDescending(i => i.CreatedAt)
            .Take(limit)
            .Select(import => new ImportSummary(
                Id: import.Id,
                GroupId: import.GroupId,
                Source: import.Source.ToString(),
                Status: import.Status.ToString(),
                Progress: import.Progress,
                Phase: RecipeImportPhaseWire.ToWire(import.Phase),
                ProgressLabel: import.ProgressLabel,
                SourceUrl: import.SourceUrl,
                CreatedAt: import.CreatedAt,
                CompletedAt: import.CompletedAt,
                Error: import.ErrorMessage))
            .ToList();

        return Results.Ok(summaries);
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
    ///
    /// BUG-013 — <b>cache-lookup before enqueue</b>: after the URL shape
    /// + group checks pass, we look for a recent successful import owned
    /// by the same caller with the same canonical URL (after
    /// <see cref="UrlNormaliser.Normalise"/> strips tracking params +
    /// lowercases the host). A hit returns 202 with the existing
    /// import-id and <c>cached: true</c> — no new Hangfire job, no
    /// Python/Whisper/Azure round-trip. The caller can force a fresh
    /// run with <c>force: true</c> (via the "Neu extrahieren"-button
    /// on the cache-hit banner). Scope is per-user (not per-group) to
    /// keep the privacy posture simple: never surface content another
    /// user extracted. TTL is <see cref="UrlImportCacheTtl"/>.
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

        // BUG-013 — canonicalise the URL before both the cache lookup
        // and the eventual insert so future re-imports from a different
        // share source (different UTM tags, host casing, fbclid noise)
        // hit the same row. The helper throws on invalid URLs; we
        // already validated shape above so only a bug in
        // TryNormalizeHttpUrl could surface here.
        var canonicalUrl = UrlNormaliser.Normalise(normalizedUrl);

        // Cache short-circuit: owner + canonical-URL match + Done state
        // + within TTL. Force=true bypasses the lookup entirely so the
        // pipeline re-runs even when a hit exists (prompt/model
        // improvements, or the user believes the source has changed).
        //
        // Postgres translates the full WHERE server-side; the SQLite
        // provider we use in tests cannot translate DateTimeOffset
        // comparisons, so we push the cheap predicates (UserId + Status
        // + SourceUrl) into the query and filter the cutoff client-side
        // over the small result set. The pattern mirrors
        // <see cref="SweepAbandonedStagedPhotosJob"/> — we do not want
        // to pull the SQLite NuGet into the production assembly just
        // for a test-path check.
        if (!body.Force)
        {
            var cutoff = clock.GetUtcNow() - UrlImportCacheTtl;
            var providerName = db.Database.ProviderName ?? string.Empty;

            RecipeImport? cachedImport;
            if (providerName.Contains("Sqlite", StringComparison.OrdinalIgnoreCase))
            {
                // SQLite cannot translate DateTimeOffset comparisons or
                // ORDER BYs — load the (small) candidate set and do both
                // the cutoff filter and the "most recent first" sort in
                // memory.
                var candidates = await db.RecipeImports.AsNoTracking()
                    .Where(i => i.UserId == callerId
                        && i.Status == ImportStatus.Done
                        && i.SourceUrl == canonicalUrl)
                    .ToListAsync(ct);
                cachedImport = candidates
                    .Where(i => i.CreatedAt > cutoff)
                    .OrderByDescending(i => i.CreatedAt)
                    .FirstOrDefault();
            }
            else
            {
                cachedImport = await db.RecipeImports.AsNoTracking()
                    .Where(i => i.UserId == callerId
                        && i.Status == ImportStatus.Done
                        && i.SourceUrl == canonicalUrl
                        && i.CreatedAt > cutoff)
                    .OrderByDescending(i => i.CreatedAt)
                    .FirstOrDefaultAsync(ct);
            }

            if (cachedImport is not null)
            {
                return Results.Accepted(
                    $"/api/imports/{cachedImport.Id}",
                    new ImportEnqueueResponse(cachedImport.Id) { Cached = true });
            }
        }

        var import = new RecipeImport(
            userId: callerId,
            groupId: body.GroupId,
            source: ImportSource.Url,
            sourceUrl: canonicalUrl,
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
