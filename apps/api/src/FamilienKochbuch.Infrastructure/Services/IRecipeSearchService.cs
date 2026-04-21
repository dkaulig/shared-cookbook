using System.Collections.Generic;

namespace FamilienKochbuch.Infrastructure.Services;

/// <summary>
/// Sort keys exposed to the API surface. Mirrors PRD §4.6.
/// </summary>
public enum SearchSort
{
    /// <summary>Most recently created/updated first.</summary>
    Newest,
    /// <summary>Best average rating first; ties broken by recency.</summary>
    BestRated,
    /// <summary>Most recently cooked first (via <c>Recipe.LastCookedAt</c>).</summary>
    LastCooked,
    /// <summary>Title ascending (A-Z). Stable tie-breaker on Id. Added
    /// alongside PAGE-0/1 so GroupDetail's sort Select can hit the
    /// search endpoint (filter/q-preserving) with the new value.</summary>
    TitleAsc,
}

/// <summary>
/// Free-form filter bag for recipe search. Every field is optional — the
/// service ANDs together only the supplied filters.
/// </summary>
public class RecipeSearchQuery
{
    public string? Q { get; init; }
    public IReadOnlyCollection<Guid>? TagIds { get; init; }
    public double? MinRating { get; init; }
    public int? MaxPrepTimeMinutes { get; init; }
    public Guid? CreatedByUserId { get; init; }
    public SearchSort Sort { get; init; } = SearchSort.Newest;
    public int Page { get; init; } = 1;
    public int PageSize { get; init; } = 20;
}

/// <summary>
/// Paginated search result. <see cref="Total"/> is the count of matches
/// before pagination is applied.
/// </summary>
public record PaginatedList<T>(IReadOnlyList<T> Items, int Page, int PageSize, int Total);

/// <summary>
/// Summary DTO returned by <see cref="IRecipeSearchService"/>. Lives in
/// Infrastructure so the Api layer can project it directly without a
/// second round-trip. Rating aggregates (<see cref="AvgRating"/>,
/// <see cref="RatingCount"/>, <see cref="MyStars"/>) piggyback on the
/// search so the filter UI renders stars on cards without a separate
/// fetch.
/// </summary>
public record RecipeSearchSummary(
    Guid Id,
    Guid GroupId,
    string Title,
    string? Description,
    string? Photo,
    IReadOnlyList<Guid> TagIds,
    string CreatedByDisplayName,
    DateTimeOffset UpdatedAt,
    DateTimeOffset? LastCookedAt,
    double? AvgRating,
    int RatingCount,
    int? MyStars);

/// <summary>
/// Search + random picker service for recipes inside a group. Callers
/// must have already verified the current user is a member of the group —
/// this service intentionally does not re-check because the endpoint
/// layer owns authorization.
/// </summary>
public interface IRecipeSearchService
{
    Task<PaginatedList<RecipeSearchSummary>> SearchAsync(
        Guid groupId,
        RecipeSearchQuery query,
        Guid currentUserId,
        CancellationToken ct);

    Task<Guid?> RandomAsync(
        Guid groupId,
        RecipeSearchQuery query,
        Guid currentUserId,
        CancellationToken ct);
}
