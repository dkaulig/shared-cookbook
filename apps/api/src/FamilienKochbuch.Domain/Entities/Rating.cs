namespace FamilienKochbuch.Domain.Entities;

/// <summary>
/// A single user's rating for a single recipe (PRD §4.3 / §8.3). The
/// (RecipeId, UserId) pair is unique by design — repeated submissions
/// become <see cref="UpdateStars"/> calls, not new rows.
/// </summary>
public class Rating
{
    public const int MinStars = 1;
    public const int MaxStars = 5;
    public const int CommentMaxLength = 2000;

    // EF-friendly parameterless ctor — private so domain construction goes
    // through the validating ctor below.
    private Rating() { }

    public Rating(
        Guid recipeId,
        Guid userId,
        int stars,
        string? comment,
        DateTimeOffset createdAt)
    {
        if (recipeId == Guid.Empty)
            throw new ArgumentException("RecipeId must not be empty.", nameof(recipeId));
        if (userId == Guid.Empty)
            throw new ArgumentException("UserId must not be empty.", nameof(userId));

        ValidateStars(stars);
        var normalizedComment = ValidateComment(comment);

        Id = Guid.NewGuid();
        RecipeId = recipeId;
        UserId = userId;
        Stars = stars;
        Comment = normalizedComment;
        CreatedAt = createdAt;
        UpdatedAt = createdAt;
    }

    public Guid Id { get; private set; }
    public Guid RecipeId { get; private set; }
    public Guid UserId { get; private set; }
    public int Stars { get; private set; }
    public string? Comment { get; private set; }
    public DateTimeOffset CreatedAt { get; private set; }
    public DateTimeOffset UpdatedAt { get; private set; }

    /// <summary>
    /// Upsert helper — the endpoint layer uses this on the existing row when
    /// the same (RecipeId, UserId) rates again. CreatedAt stays untouched;
    /// UpdatedAt advances.
    /// </summary>
    public void UpdateStars(int stars, string? comment, DateTimeOffset now)
    {
        ValidateStars(stars);
        var normalizedComment = ValidateComment(comment);

        Stars = stars;
        Comment = normalizedComment;
        UpdatedAt = now;
    }

    private static void ValidateStars(int stars)
    {
        if (stars < MinStars || stars > MaxStars)
            throw new ArgumentException(
                $"Stars must be between {MinStars} and {MaxStars}.", nameof(stars));
    }

    private static string? ValidateComment(string? comment)
    {
        if (string.IsNullOrWhiteSpace(comment)) return null;
        var trimmed = comment.Trim();
        if (trimmed.Length > CommentMaxLength)
            throw new ArgumentException(
                $"Comment must be at most {CommentMaxLength} characters.", nameof(comment));
        return trimmed;
    }
}
