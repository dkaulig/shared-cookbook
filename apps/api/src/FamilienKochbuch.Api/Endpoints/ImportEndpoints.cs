using System.Security.Claims;
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
    public record ImportStatusResponse(
        Guid Id,
        string Source,
        string Status,
        int Progress,
        string? SourceUrl,
        string? Result,
        string? Error,
        DateTimeOffset CreatedAt,
        DateTimeOffset? CompletedAt);

    /// <summary>Body of <c>POST /api/recipes/import/url</c>.</summary>
    public record UrlImportRequest(string Url, Guid GroupId);

    /// <summary>Response of enqueue endpoints.</summary>
    public record ImportEnqueueResponse(Guid ImportId);

    public static void MapImportEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/api/imports").WithTags("Imports");
        group.MapGet("/{importId:guid}", GetImportAsync).RequireAuthorization();

        // P2-6 step 1 — user-facing enqueue endpoints under /api/recipes/import.
        // Mounted separately from the /api/imports group because the route
        // belongs with the "recipes" surface area in the frontend's mental
        // model ("I import a recipe") even though it writes a RecipeImport.
        var enqueue = app.MapGroup("/api/recipes/import").WithTags("Imports");
        enqueue.MapPost("/url", EnqueueUrlImportAsync).RequireAuthorization();
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
            CompletedAt: import.CompletedAt));
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
}
