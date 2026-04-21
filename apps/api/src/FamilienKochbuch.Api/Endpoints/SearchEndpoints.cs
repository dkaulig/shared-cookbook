using System.Security.Claims;
using FamilienKochbuch.Infrastructure.Persistence;
using FamilienKochbuch.Infrastructure.Services;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;

namespace FamilienKochbuch.Api.Endpoints;

/// <summary>
/// S4 recipe search + random picker. Query params are intentionally
/// simple so URL-state in the web client stays flat (shareable links).
/// Results reuse <see cref="RecipeEndpoints.RecipeSummaryDto"/> so the
/// client only has one summary shape to render.
/// </summary>
public static class SearchEndpoints
{
    public const int DefaultPageSize = 20;
    public const int MaxPageSize = 100;

    public record SearchResultDto(
        RecipeEndpoints.RecipeSummaryDto[] Items,
        int Page,
        int PageSize,
        int Total);

    public record RandomRecipeResponse(Guid? RecipeId);

    public static void MapSearchEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/api/groups/{groupId:guid}/recipes")
            .WithTags("Search")
            .RequireAuthorization();
        group.MapGet("/search", SearchAsync);
        group.MapGet("/random", RandomAsync);
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    private static bool TryGetUserId(ClaimsPrincipal principal, out Guid userId)
    {
        userId = Guid.Empty;
        var sub = principal.FindFirstValue("sub")
                  ?? principal.FindFirstValue(ClaimTypes.NameIdentifier);
        return Guid.TryParse(sub, out userId);
    }

    private static Task<bool> IsGroupMemberAsync(AppDbContext db, Guid groupId, Guid userId, CancellationToken ct) =>
        db.GroupMemberships.AnyAsync(m => m.GroupId == groupId && m.UserId == userId, ct);

    private static RecipeSearchQuery ParseQuery(
        string? q,
        string? tags,
        double? minRating,
        int? maxPrepTime,
        Guid? createdBy,
        string? sort,
        int? page,
        int? pageSize)
    {
        var tagIds = string.IsNullOrWhiteSpace(tags)
            ? Array.Empty<Guid>()
            : tags.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Select(piece => Guid.TryParse(piece, out var g) ? g : Guid.Empty)
                .Where(g => g != Guid.Empty)
                .Distinct()
                .ToArray();

        // Accepts both legacy 3-value set (`newest|best_rated|last_cooked`)
        // and the PAGE-0/1 list-endpoint set (`updated_desc|rating_desc|
        // cooked_desc|title_asc`). `updated_desc` maps to `Newest` because
        // the search endpoint tracks "most recently created" and the list
        // endpoint tracks "most recently updated" — close enough that we
        // fold them together until the Cross-Group-Search slice reworks
        // filters proper. `cook_count_desc` was cut from PAGE-0 and is NOT
        // accepted here — unknown values fall through to the default.
        var sortKind = sort?.ToLowerInvariant() switch
        {
            "best_rated" or "rating_desc" => SearchSort.BestRated,
            "last_cooked" or "cooked_desc" => SearchSort.LastCooked,
            "title_asc" => SearchSort.TitleAsc,
            _ => SearchSort.Newest,
        };

        return new RecipeSearchQuery
        {
            Q = q,
            TagIds = tagIds,
            MinRating = minRating,
            MaxPrepTimeMinutes = maxPrepTime,
            CreatedByUserId = createdBy,
            Sort = sortKind,
            Page = page ?? 1,
            PageSize = pageSize ?? DefaultPageSize,
        };
    }

    // ── GET /api/groups/{groupId}/recipes/search ────────────────────────

    private static async Task<IResult> SearchAsync(
        Guid groupId,
        string? q,
        string? tags,
        double? minRating,
        int? maxPrepTime,
        Guid? createdBy,
        string? sort,
        int? page,
        int? pageSize,
        ClaimsPrincipal principal,
        AppDbContext db,
        IRecipeSearchService search,
        IPhotoStorage photoStorage,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var group = await db.Groups.FirstOrDefaultAsync(g => g.Id == groupId && g.DeletedAt == null, ct);
        if (group is null) return Results.NotFound();
        if (!await IsGroupMemberAsync(db, groupId, userId, ct)) return Results.Forbid();

        var query = ParseQuery(q, tags, minRating, maxPrepTime, createdBy, sort, page, pageSize);
        var result = await search.SearchAsync(groupId, query, userId, ct);

        var items = result.Items.Select(summary => new RecipeEndpoints.RecipeSummaryDto(
            summary.Id,
            summary.GroupId,
            summary.Title,
            summary.Description,
            string.IsNullOrEmpty(summary.Photo) ? null : photoStorage.GetPublicUrl(summary.Photo),
            summary.TagIds.ToArray(),
            summary.CreatedByDisplayName,
            summary.UpdatedAt,
            summary.AvgRating,
            summary.RatingCount,
            summary.MyStars)).ToArray();

        return Results.Ok(new SearchResultDto(items, result.Page, result.PageSize, result.Total));
    }

    // ── GET /api/groups/{groupId}/recipes/random ────────────────────────

    private static async Task<IResult> RandomAsync(
        Guid groupId,
        string? q,
        string? tags,
        double? minRating,
        int? maxPrepTime,
        Guid? createdBy,
        string? sort,
        ClaimsPrincipal principal,
        AppDbContext db,
        IRecipeSearchService search,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var group = await db.Groups.FirstOrDefaultAsync(g => g.Id == groupId && g.DeletedAt == null, ct);
        if (group is null) return Results.NotFound();
        if (!await IsGroupMemberAsync(db, groupId, userId, ct)) return Results.Forbid();

        var query = ParseQuery(q, tags, minRating, maxPrepTime, createdBy, sort, page: 1, pageSize: 1);
        var id = await search.RandomAsync(groupId, query, userId, ct);
        return Results.Ok(new RandomRecipeResponse(id));
    }
}
