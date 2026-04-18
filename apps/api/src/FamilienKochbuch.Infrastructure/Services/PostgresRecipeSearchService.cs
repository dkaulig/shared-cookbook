using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace FamilienKochbuch.Infrastructure.Services;

/// <summary>
/// Recipe search + random picker. On Postgres the implementation leans on
/// the <c>SearchVector</c> tsvector column and GIN index set up by the
/// <c>AddRatingsAndSearch</c> migration; on SQLite (integration tests) it
/// falls back to a LIKE-based scan over title, description, and each
/// ingredient name. The service assumes the caller has already verified
/// the current user's group membership.
/// </summary>
public class PostgresRecipeSearchService(AppDbContext db) : IRecipeSearchService
{
    public const int DefaultPageSize = 20;
    public const int MaxPageSize = 100;

    public async Task<PaginatedList<RecipeSearchSummary>> SearchAsync(
        Guid groupId,
        RecipeSearchQuery query,
        Guid currentUserId,
        CancellationToken ct)
    {
        var baseQuery = BuildFilteredQuery(groupId, query);

        var total = await baseQuery.CountAsync(ct);

        var p = Math.Max(query.Page, 1);
        var size = Math.Clamp(query.PageSize <= 0 ? DefaultPageSize : query.PageSize, 1, MaxPageSize);

        // Aggregates per recipe, computed server-side via correlated
        // subqueries. EF Core composes each into a LINQ-provider-friendly
        // SQL fragment. SQLite can't ORDER BY DateTimeOffset, so on the
        // fallback path we materialize first and sort/page in memory —
        // same pattern as the list endpoint. On Postgres we keep sort +
        // pagination on the server.
        var projected = baseQuery.Select(r => new ProjectedRow
        {
            Recipe = r,
            CreatorDisplay = db.Users.Where(u => u.Id == r.CreatedByUserId)
                .Select(u => u.DisplayName).FirstOrDefault() ?? string.Empty,
            AvgRating = db.Ratings.Where(rt => rt.RecipeId == r.Id)
                .Select(rt => (double?)rt.Stars).Average(),
            RatingCount = db.Ratings.Count(rt => rt.RecipeId == r.Id),
            MyStars = db.Ratings
                .Where(rt => rt.RecipeId == r.Id && rt.UserId == currentUserId)
                .Select(rt => (int?)rt.Stars)
                .FirstOrDefault(),
        });

        List<ProjectedRow> rows;
        if (IsPostgres)
        {
            rows = await ApplySort(projected, query.Sort)
                .Skip((p - 1) * size)
                .Take(size)
                .ToListAsync(ct);
        }
        else
        {
            var all = await projected.ToListAsync(ct);
            rows = ApplySortInMemory(all, query.Sort)
                .Skip((p - 1) * size)
                .Take(size)
                .ToList();
        }

        var ids = rows.Select(row => row.Recipe.Id).ToArray();
        var tagMap = await db.RecipeTags
            .Where(rt => ids.Contains(rt.RecipeId))
            .Select(rt => new { rt.RecipeId, rt.TagId })
            .ToListAsync(ct);
        var tagsByRecipe = tagMap
            .GroupBy(x => x.RecipeId)
            .ToDictionary(g => g.Key, g => g.Select(x => x.TagId).ToArray());

        var items = rows.Select(row => new RecipeSearchSummary(
            row.Recipe.Id,
            row.Recipe.GroupId,
            row.Recipe.Title,
            row.Recipe.Description,
            row.Recipe.Photos.FirstOrDefault(),
            tagsByRecipe.TryGetValue(row.Recipe.Id, out var t) ? t : Array.Empty<Guid>(),
            row.CreatorDisplay,
            row.Recipe.UpdatedAt,
            row.Recipe.LastCookedAt,
            row.RatingCount == 0 ? null : row.AvgRating,
            row.RatingCount,
            row.MyStars)).ToList();

        return new PaginatedList<RecipeSearchSummary>(items, p, size, total);
    }

    public async Task<Guid?> RandomAsync(
        Guid groupId,
        RecipeSearchQuery query,
        Guid currentUserId,
        CancellationToken ct)
    {
        _ = currentUserId; // Random picker doesn't need MyStars; kept for symmetry.

        // ORDER BY RANDOM() → LIMIT 1. Portable across Postgres (random())
        // and SQLite (random()). Ok at hobby scale (group corpora are
        // small).
        var id = await BuildFilteredQuery(groupId, query)
            .OrderBy(r => EF.Functions.Random())
            .Select(r => (Guid?)r.Id)
            .FirstOrDefaultAsync(ct);

        return id;
    }

    // ── Query builder ───────────────────────────────────────────────────

    private IQueryable<Recipe> BuildFilteredQuery(Guid groupId, RecipeSearchQuery query)
    {
        var q = db.Recipes.AsQueryable()
            .Where(r => r.GroupId == groupId && r.DeletedAt == null);

        if (!string.IsNullOrWhiteSpace(query.Q))
        {
            var term = query.Q.Trim();
            if (IsPostgres)
            {
                // Leverage the trigger-maintained tsvector + GIN index.
                // websearch_to_tsquery accepts user-friendly syntax and is
                // forgiving of whitespace, quotes, etc. We rebuild the
                // vector inline rather than referring to the stored
                // Recipes.SearchVector column because EF Core doesn't know
                // about it (it's trigger-maintained, not mapped) — the
                // resulting SQL is equivalent and Postgres is smart enough
                // to reuse the stored vector when present via the GIN
                // expression index.
                q = q.Where(r =>
                    EF.Functions.ToTsVector("german",
                        r.Title + " " + (r.Description ?? "") + " " +
                        string.Join(" ", r.Ingredients.Select(i => i.Name)))
                    .Matches(EF.Functions.WebSearchToTsQuery("german", term)));
            }
            else
            {
                // SQLite fallback — integration-test path. Plain LIKE scan
                // against Title, Description, and any Ingredient.Name. Good
                // enough for a few dozen rows per group in tests.
                var like = $"%{term}%";
                q = q.Where(r =>
                    EF.Functions.Like(r.Title, like)
                    || (r.Description != null && EF.Functions.Like(r.Description, like))
                    || r.Ingredients.Any(i => EF.Functions.Like(i.Name, like)));
            }
        }

        if (query.TagIds is { Count: > 0 })
        {
            // AND semantics: a recipe must carry EVERY requested tag (PRD
            // §4.6: "with these tags"). Implemented as one EXISTS clause
            // per requested tag — each correlated subquery gets folded into
            // the generated SQL.
            foreach (var tagId in query.TagIds.Distinct())
            {
                var required = tagId;
                q = q.Where(r => r.RecipeTags.Any(rt => rt.TagId == required));
            }
        }

        if (query.MinRating is { } minRating)
        {
            // Avg on no rows is 0 in SQL, so the >= minRating filter does
            // the right thing for unrated recipes (they drop out once
            // minRating > 0).
            q = q.Where(r => db.Ratings.Where(rt => rt.RecipeId == r.Id)
                .Select(rt => (double?)rt.Stars)
                .Average() >= minRating);
        }

        if (query.MaxPrepTimeMinutes is { } maxPrep)
        {
            q = q.Where(r => r.PrepTimeMinutes != null && r.PrepTimeMinutes <= maxPrep);
        }

        if (query.CreatedByUserId is { } creator)
        {
            q = q.Where(r => r.CreatedByUserId == creator);
        }

        return q;
    }

    private bool IsPostgres =>
        db.Database.ProviderName?.Contains("Npgsql", StringComparison.OrdinalIgnoreCase) == true;

    private static IQueryable<ProjectedRow> ApplySort(
        IQueryable<ProjectedRow> query, SearchSort sort) => sort switch
    {
        SearchSort.BestRated => query
            .OrderByDescending(x => x.AvgRating ?? -1.0)
            .ThenByDescending(x => x.Recipe.UpdatedAt),
        SearchSort.LastCooked => query
            .OrderByDescending(x => x.Recipe.LastCookedAt ?? DateTimeOffset.MinValue)
            .ThenByDescending(x => x.Recipe.UpdatedAt),
        _ => query.OrderByDescending(x => x.Recipe.CreatedAt),
    };

    private static IEnumerable<ProjectedRow> ApplySortInMemory(
        IEnumerable<ProjectedRow> rows, SearchSort sort) => sort switch
    {
        SearchSort.BestRated => rows
            .OrderByDescending(x => x.AvgRating ?? -1.0)
            .ThenByDescending(x => x.Recipe.UpdatedAt),
        SearchSort.LastCooked => rows
            .OrderByDescending(x => x.Recipe.LastCookedAt ?? DateTimeOffset.MinValue)
            .ThenByDescending(x => x.Recipe.UpdatedAt),
        _ => rows.OrderByDescending(x => x.Recipe.CreatedAt),
    };

    private sealed class ProjectedRow
    {
        public Recipe Recipe { get; set; } = null!;
        public string CreatorDisplay { get; set; } = string.Empty;
        public double? AvgRating { get; set; }
        public int RatingCount { get; set; }
        public int? MyStars { get; set; }
    }
}
