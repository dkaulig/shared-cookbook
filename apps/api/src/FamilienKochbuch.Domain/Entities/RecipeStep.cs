namespace FamilienKochbuch.Domain.Entities;

/// <summary>
/// Ordered preparation step of a <see cref="Recipe"/>. Content is
/// Markdown-friendly plain text (bold/lists); rendering is a UI concern.
/// </summary>
public class RecipeStep
{
    public const int ContentMaxLength = 5000;

    // EF-friendly parameterless ctor — private so domain construction goes
    // through the validating ctor below.
    private RecipeStep() { }

    public RecipeStep(Guid recipeId, int position, string content)
    {
        if (position < 0)
            throw new ArgumentException("Position must not be negative.", nameof(position));
        if (string.IsNullOrWhiteSpace(content))
            throw new ArgumentException("Step content must not be blank.", nameof(content));

        var trimmed = content.Trim();
        if (trimmed.Length > ContentMaxLength)
            throw new ArgumentException(
                $"Step content must be at most {ContentMaxLength} characters.", nameof(content));

        Id = Guid.NewGuid();
        RecipeId = recipeId;
        Position = position;
        Content = trimmed;
    }

    public Guid Id { get; private set; }
    public Guid RecipeId { get; private set; }
    public int Position { get; private set; }
    public string Content { get; private set; } = string.Empty;
}
