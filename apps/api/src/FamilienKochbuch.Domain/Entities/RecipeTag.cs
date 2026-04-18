namespace FamilienKochbuch.Domain.Entities;

/// <summary>
/// M:N join between <see cref="Recipe"/> and <see cref="Tag"/>. Composite
/// primary key (RecipeId, TagId) enforced at the infrastructure layer; this
/// type only ensures neither id is empty.
/// </summary>
public class RecipeTag
{
    // EF-friendly parameterless ctor — private.
    private RecipeTag() { }

    public RecipeTag(Guid recipeId, Guid tagId)
    {
        if (recipeId == Guid.Empty)
            throw new ArgumentException("RecipeId must not be empty.", nameof(recipeId));
        if (tagId == Guid.Empty)
            throw new ArgumentException("TagId must not be empty.", nameof(tagId));

        RecipeId = recipeId;
        TagId = tagId;
    }

    public Guid RecipeId { get; private set; }
    public Guid TagId { get; private set; }
}
