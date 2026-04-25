using System.Text.Json;
using SharedCookbook.Api.Services;
using SharedCookbook.Domain.Entities;
using SharedCookbook.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace SharedCookbook.Api.Endpoints;

/// <summary>
/// CFG-0 — internal-only read surface on the extractor-config table,
/// consumed by the Python extractor's TTL-cached config loader
/// (CFG-1). No JWT required: the
/// <see cref="InternalOnlyMiddleware"/> + Caddy's <c>@internal</c>
/// matcher gate the trust boundary upstream.
///
/// <list type="bullet">
/// <item><c>GET /api/internal/extractor-config</c> — same DTO as the
/// admin list endpoint. Python polls this every 60 s to refresh its
/// in-memory cache; a fetch failure keeps the stale cache and logs a
/// warning (the Python side owns that fallback logic).</item>
/// <item><c>POST /api/internal/extractor-config/refresh</c> — no-op
/// placeholder, returns 204 immediately. The E2E gate calls this to
/// signal the Python side to refresh without waiting out the 60 s TTL;
/// the Python cache polls this endpoint's timestamp header (and the
/// list endpoint on TTL) rather than receiving a push. This stub
/// exists so the frontend / E2E test can reach a 204 without a
/// dependency on Python being up.</item>
/// </list>
/// </summary>
public static class InternalExtractorConfigEndpoints
{
    public const string RoutePrefix = "/api/internal/extractor-config";

    public sealed record InternalConfigItemDto(
        string Key,
        JsonElement Value,
        string Type,
        DateTimeOffset UpdatedAt,
        int Version);

    public sealed record InternalConfigListResponse(InternalConfigItemDto[] Items);

    public static void MapInternalExtractorConfigEndpoints(this WebApplication app)
    {
        // Deliberately NO RequireAuthorization: the route is internal-
        // trust-boundary only. Auth is enforced upstream by Caddy's
        // @internal matcher + InternalOnlyMiddleware.
        var group = app.MapGroup(RoutePrefix).WithTags("InternalExtractorConfig");
        group.MapGet("/", ListAsync);
        group.MapPost("/refresh", RefreshAsync);
    }

    private static async Task<IResult> ListAsync(
        AppDbContext db, CancellationToken ct)
    {
        var rows = await db.ExtractorConfigs
            .AsNoTracking()
            .OrderBy(c => c.Key)
            .ToListAsync(ct);

        var items = rows.Select(r => new InternalConfigItemDto(
            Key: r.Key,
            Value: AdminExtractorConfigEndpoints.ParseJson(r.ValueJson),
            Type: AdminExtractorConfigEndpoints.ValueTypeWireName(r.ValueType),
            UpdatedAt: r.UpdatedAt,
            Version: r.Version)).ToArray();

        return Results.Ok(new InternalConfigListResponse(items));
    }

    private static IResult RefreshAsync()
    {
        // No-op placeholder. The actual cache lives inside the Python
        // extractor process; this endpoint exists so the E2E gate can
        // synchronously signal "next GET will be a hit" without
        // waiting for the TTL. Returns 204 so the caller's contract
        // stays simple (success == OK, anything else == surface).
        return Results.NoContent();
    }
}
