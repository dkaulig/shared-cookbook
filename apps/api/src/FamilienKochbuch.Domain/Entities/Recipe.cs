using FamilienKochbuch.Domain.Enums;

namespace FamilienKochbuch.Domain.Entities;

/// <summary>
/// A recipe lives in exactly one <see cref="Group"/>, is authored by a
/// single user, and aggregates ordered <see cref="Ingredients"/>,
/// ordered <see cref="Steps"/>, and a set of <see cref="RecipeTags"/>.
/// PRD §4.1 / §8.3 invariants: title required (1..200), default servings
/// positive, difficulty in 1..3, at most three photos.
/// </summary>
public class Recipe
{
    public const int TitleMaxLength = 200;
    public const int DescriptionMaxLength = 2000;
    public const int SourceUrlMaxLength = 2000;
    public const int MaxPhotos = 3;
    public const int MinDifficulty = 1;
    public const int MaxDifficulty = 3;

    // EF-friendly parameterless ctor — private so domain construction goes
    // through the validating ctor below.
    private Recipe() { }

    public Recipe(
        Guid groupId,
        Guid createdByUserId,
        string title,
        string? description,
        int defaultServings,
        int? prepTimeMinutes,
        int difficulty,
        string? sourceUrl,
        RecipeSourceType sourceType,
        Guid? forkOfRecipeId,
        DateTimeOffset createdAt)
    {
        if (groupId == Guid.Empty)
            throw new ArgumentException("GroupId must not be empty.", nameof(groupId));
        if (createdByUserId == Guid.Empty)
            throw new ArgumentException("CreatedByUserId must not be empty.", nameof(createdByUserId));

        var trimmedTitle = ValidateTitle(title);
        var normalizedDescription = ValidateDescription(description);
        ValidateDefaultServings(defaultServings);
        ValidatePrepTime(prepTimeMinutes);
        ValidateDifficulty(difficulty);
        var normalizedSourceUrl = ValidateSourceUrl(sourceUrl);

        Id = Guid.NewGuid();
        GroupId = groupId;
        CreatedByUserId = createdByUserId;
        Title = trimmedTitle;
        Description = normalizedDescription;
        DefaultServings = defaultServings;
        PrepTimeMinutes = prepTimeMinutes;
        Difficulty = difficulty;
        SourceUrl = normalizedSourceUrl;
        SourceType = sourceType;
        ForkOfRecipeId = forkOfRecipeId;
        CreatedAt = createdAt;
        UpdatedAt = createdAt;
    }

    public Guid Id { get; private set; }
    public Guid GroupId { get; private set; }
    public Guid CreatedByUserId { get; private set; }
    public string Title { get; private set; } = string.Empty;
    public string? Description { get; private set; }
    public int DefaultServings { get; private set; }
    public int? PrepTimeMinutes { get; private set; }
    public int Difficulty { get; private set; }
    public string? SourceUrl { get; private set; }
    public RecipeSourceType SourceType { get; private set; }
    public Guid? ForkOfRecipeId { get; private set; }

    /// <summary>Ordered photo URLs. Max 3. Managed via <see cref="AddPhoto"/>
    /// / <see cref="RemovePhoto"/>.</summary>
    public List<string> Photos { get; private set; } = new();

    public DateTimeOffset? LastCookedAt { get; private set; }
    public DateTimeOffset CreatedAt { get; private set; }
    public DateTimeOffset UpdatedAt { get; private set; }
    public DateTimeOffset? DeletedAt { get; private set; }

    /// <summary>
    /// Optional LLM-estimated per-portion nutrition (P2-10). ``null``
    /// when no estimate is available. Manage via
    /// <see cref="SetNutritionEstimate"/>.
    /// </summary>
    public NutritionEstimate? NutritionEstimate { get; private set; }

    // ── Aggregated children ─────────────────────────────────────────

    public ICollection<Ingredient> Ingredients { get; private set; } = new List<Ingredient>();
    public ICollection<RecipeStep> Steps { get; private set; } = new List<RecipeStep>();
    public ICollection<RecipeTag> RecipeTags { get; private set; } = new List<RecipeTag>();

    // ── Behaviour ──────────────────────────────────────────────────

    /// <summary>Updates mutable metadata. Use server-driven replace semantics
    /// (PUT) in the endpoint layer — this just bundles validation.</summary>
    public void UpdateMetadata(
        string title,
        string? description,
        int defaultServings,
        int? prepTimeMinutes,
        int difficulty,
        string? sourceUrl,
        RecipeSourceType sourceType,
        DateTimeOffset updatedAt)
    {
        var trimmedTitle = ValidateTitle(title);
        var normalizedDescription = ValidateDescription(description);
        ValidateDefaultServings(defaultServings);
        ValidatePrepTime(prepTimeMinutes);
        ValidateDifficulty(difficulty);
        var normalizedSourceUrl = ValidateSourceUrl(sourceUrl);

        Title = trimmedTitle;
        Description = normalizedDescription;
        DefaultServings = defaultServings;
        PrepTimeMinutes = prepTimeMinutes;
        Difficulty = difficulty;
        SourceUrl = normalizedSourceUrl;
        SourceType = sourceType;
        UpdatedAt = updatedAt;
    }

    public void AddPhoto(string url)
    {
        if (string.IsNullOrWhiteSpace(url))
            throw new ArgumentException("Photo URL must not be blank.", nameof(url));
        if (Photos.Count >= MaxPhotos)
            throw new InvalidOperationException(
                $"A recipe may have at most {MaxPhotos} photos.");

        Photos.Add(url.Trim());
    }

    public bool RemovePhoto(string url)
    {
        if (string.IsNullOrWhiteSpace(url))
            throw new ArgumentException("Photo URL must not be blank.", nameof(url));

        return Photos.Remove(url.Trim());
    }

    public void MarkCooked(DateTimeOffset at) => LastCookedAt = at;

    public void SoftDelete(DateTimeOffset at) => DeletedAt = at;

    /// <summary>
    /// Replaces (or clears, when <paramref name="estimate"/> is
    /// <c>null</c>) the per-portion nutrition estimate. P2-10.
    /// </summary>
    public void SetNutritionEstimate(NutritionEstimate? estimate, DateTimeOffset at)
    {
        NutritionEstimate = estimate;
        UpdatedAt = at;
    }

    // ── Validation helpers ─────────────────────────────────────────

    private static string ValidateTitle(string title)
    {
        if (string.IsNullOrWhiteSpace(title))
            throw new ArgumentException("Recipe title must not be blank.", nameof(title));
        var trimmed = title.Trim();
        if (trimmed.Length > TitleMaxLength)
            throw new ArgumentException(
                $"Recipe title must be at most {TitleMaxLength} characters.", nameof(title));
        return trimmed;
    }

    private static string? ValidateDescription(string? description)
    {
        if (string.IsNullOrWhiteSpace(description)) return null;
        var trimmed = description.Trim();
        if (trimmed.Length > DescriptionMaxLength)
            throw new ArgumentException(
                $"Recipe description must be at most {DescriptionMaxLength} characters.", nameof(description));
        return trimmed;
    }

    private static void ValidateDefaultServings(int defaultServings)
    {
        if (defaultServings <= 0)
            throw new ArgumentException(
                "Default servings must be greater than zero.", nameof(defaultServings));
    }

    private static void ValidatePrepTime(int? prepTimeMinutes)
    {
        if (prepTimeMinutes is < 0)
            throw new ArgumentException(
                "Preparation time must not be negative.", nameof(prepTimeMinutes));
    }

    private static void ValidateDifficulty(int difficulty)
    {
        if (difficulty < MinDifficulty || difficulty > MaxDifficulty)
            throw new ArgumentException(
                $"Difficulty must be between {MinDifficulty} and {MaxDifficulty}.", nameof(difficulty));
    }

    private static string? ValidateSourceUrl(string? sourceUrl)
    {
        if (string.IsNullOrWhiteSpace(sourceUrl)) return null;
        var trimmed = sourceUrl.Trim();
        if (trimmed.Length > SourceUrlMaxLength)
            throw new ArgumentException(
                $"Source URL must be at most {SourceUrlMaxLength} characters.", nameof(sourceUrl));
        return trimmed;
    }
}
