using System.Security.Claims;
using FamilienKochbuch.Api.Services;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Infrastructure.Persistence;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;

namespace FamilienKochbuch.Api.Endpoints;

/// <summary>
/// S4 rating endpoints — per-recipe 1..5 stars per user, upsert semantics,
/// aggregate (avg/count) alongside the caller's own rating.
/// </summary>
public static class RatingEndpoints
{
    // ── DTO records ─────────────────────────────────────────────────────

    public record UpsertRatingRequest(int Stars, string? Comment);

    public record RatingDto(
        Guid UserId,
        string DisplayName,
        int Stars,
        string? Comment,
        DateTimeOffset CreatedAt,
        DateTimeOffset UpdatedAt);

    public record RatingAggregate(
        double? Avg,
        int Count,
        int? MyStars,
        string? MyComment);

    public record UpsertRatingResponse(RatingAggregate Aggregate, RatingDto Rating);

    public record RatingListResponse(RatingAggregate Aggregate, RatingDto[] Ratings);

    // ── Endpoint wiring ─────────────────────────────────────────────────

    public static void MapRatingEndpoints(this WebApplication app)
    {
        var ratings = app.MapGroup("/api/recipes/{id:guid}/ratings")
            .WithTags("Ratings")
            .RequireAuthorization();
        ratings.MapPost("/", UpsertRatingAsync);
        ratings.MapDelete("/", DeleteRatingAsync);
        ratings.MapGet("/", ListRatingsAsync);
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

    private static async Task<RatingAggregate> ComputeAggregateAsync(
        AppDbContext db, Guid recipeId, Guid currentUserId, CancellationToken ct)
    {
        var ratings = await db.Ratings.Where(r => r.RecipeId == recipeId)
            .Select(r => new { r.UserId, r.Stars, r.Comment })
            .ToListAsync(ct);

        double? avg = ratings.Count == 0
            ? null
            : Math.Round(ratings.Average(r => (double)r.Stars), 1);
        var mine = ratings.FirstOrDefault(r => r.UserId == currentUserId);

        return new RatingAggregate(
            Avg: avg,
            Count: ratings.Count,
            MyStars: mine is null ? null : mine.Stars,
            MyComment: mine?.Comment);
    }

    // ── POST /api/recipes/{id}/ratings ──────────────────────────────────

    private static async Task<IResult> UpsertRatingAsync(
        Guid id,
        UpsertRatingRequest body,
        ClaimsPrincipal principal,
        AppDbContext db,
        TimeProvider clock,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var recipe = await db.Recipes.FirstOrDefaultAsync(r => r.Id == id && r.DeletedAt == null, ct);
        if (recipe is null) return Results.NotFound();
        if (!await IsGroupMemberAsync(db, recipe.GroupId, userId, ct)) return Results.Forbid();

        Rating savedRating;
        try
        {
            var now = clock.GetUtcNow();
            var existing = await db.Ratings
                .FirstOrDefaultAsync(r => r.RecipeId == id && r.UserId == userId, ct);

            if (existing is null)
            {
                savedRating = new Rating(id, userId, body.Stars, body.Comment, now);
                db.Ratings.Add(savedRating);
            }
            else
            {
                existing.UpdateStars(body.Stars, body.Comment, now);
                savedRating = existing;
            }
            await db.SaveChangesAsync(ct);
        }
        catch (ArgumentException)
        {
            return FamilienResults.BadRequest(
                ErrorCodes.InvalidInput, "Invalid rating payload.");
        }

        var displayName = await db.Users.Where(u => u.Id == userId)
            .Select(u => u.DisplayName).SingleAsync(ct);
        var aggregate = await ComputeAggregateAsync(db, id, userId, ct);
        return Results.Ok(new UpsertRatingResponse(
            aggregate,
            new RatingDto(userId, displayName, savedRating.Stars, savedRating.Comment,
                savedRating.CreatedAt, savedRating.UpdatedAt)));
    }

    // ── DELETE /api/recipes/{id}/ratings ────────────────────────────────

    private static async Task<IResult> DeleteRatingAsync(
        Guid id,
        ClaimsPrincipal principal,
        AppDbContext db,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var recipe = await db.Recipes.FirstOrDefaultAsync(r => r.Id == id && r.DeletedAt == null, ct);
        if (recipe is null) return Results.NotFound();
        if (!await IsGroupMemberAsync(db, recipe.GroupId, userId, ct)) return Results.Forbid();

        var existing = await db.Ratings
            .FirstOrDefaultAsync(r => r.RecipeId == id && r.UserId == userId, ct);
        if (existing is not null)
        {
            db.Ratings.Remove(existing);
            await db.SaveChangesAsync(ct);
        }

        return Results.NoContent();
    }

    // ── GET /api/recipes/{id}/ratings ───────────────────────────────────

    private static async Task<IResult> ListRatingsAsync(
        Guid id,
        ClaimsPrincipal principal,
        AppDbContext db,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var recipe = await db.Recipes.FirstOrDefaultAsync(r => r.Id == id && r.DeletedAt == null, ct);
        if (recipe is null) return Results.NotFound();
        if (!await IsGroupMemberAsync(db, recipe.GroupId, userId, ct)) return Results.Forbid();

        // Sort by UpdatedAt DESC in memory — SQLite can't ORDER BY
        // DateTimeOffset server-side. Rating counts per recipe stay small
        // (at most one per group member), so client-side sort is fine.
        var raw = await db.Ratings
            .Where(r => r.RecipeId == id)
            .Join(db.Users, r => r.UserId, u => u.Id, (r, u) => new
            {
                r.UserId,
                u.DisplayName,
                r.Stars,
                r.Comment,
                r.CreatedAt,
                r.UpdatedAt,
            })
            .ToListAsync(ct);

        var ratings = raw
            .OrderByDescending(r => r.UpdatedAt)
            .Select(r => new RatingDto(r.UserId, r.DisplayName, r.Stars, r.Comment, r.CreatedAt, r.UpdatedAt))
            .ToArray();

        var aggregate = await ComputeAggregateAsync(db, id, userId, ct);
        return Results.Ok(new RatingListResponse(aggregate, ratings));
    }
}
