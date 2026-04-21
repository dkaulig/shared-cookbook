namespace FamilienKochbuch.Domain.Entities;

/// <summary>
/// COMP-0 — sub-recipe grouping for <see cref="Recipe"/>. Every ingredient
/// and step now belongs to exactly one component; a single-block recipe
/// has one default component with <see cref="Label"/> = <c>null</c> and
/// <see cref="Position"/> = 0, while recipes with visible sub-blocks
/// ("Ingredients (Sauce):") surface as multiple components in emit-order.
///
/// Invariants (enforced by <see cref="Recipe.ReplaceComponents"/>):
/// <list type="bullet">
/// <item>Position is 0-based and unique within the owning recipe.</item>
/// <item>Label is nullable; when non-null it is trimmed and non-empty.</item>
/// <item>A component's <see cref="RecipeId"/> is immutable — cross-recipe
/// moves are not supported by the domain.</item>
/// </list>
/// </summary>
public class RecipeComponent
{
    public const int LabelMaxLength = 120;

    // EF-friendly parameterless ctor — private so domain construction goes
    // through the validating ctor below.
    private RecipeComponent() { }

    public RecipeComponent(Guid recipeId, int position, string? label)
    {
        if (recipeId == Guid.Empty)
            throw new ArgumentException("RecipeId must not be empty.", nameof(recipeId));
        if (position < 0)
            throw new ArgumentException("Position must not be negative.", nameof(position));

        string? normalizedLabel = null;
        if (!string.IsNullOrWhiteSpace(label))
        {
            var trimmed = label.Trim();
            if (trimmed.Length > LabelMaxLength)
                throw new ArgumentException(
                    $"Component label must be at most {LabelMaxLength} characters.", nameof(label));
            normalizedLabel = trimmed;
        }

        Id = Guid.NewGuid();
        RecipeId = recipeId;
        Position = position;
        Label = normalizedLabel;
    }

    public Guid Id { get; private set; }
    public Guid RecipeId { get; private set; }
    public int Position { get; private set; }
    public string? Label { get; private set; }
}
