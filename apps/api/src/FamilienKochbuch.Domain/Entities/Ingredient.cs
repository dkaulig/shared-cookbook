namespace FamilienKochbuch.Domain.Entities;

/// <summary>
/// Structured ingredient entry of a <see cref="Recipe"/>. PRD §4.5 edge cases:
///   * Quantity can be null ("nach Geschmack", "eine Prise"). In that case
///     <see cref="Scalable"/> MUST be false — you can't scale what isn't
///     quantified.
///   * When scalable, the quantity must be strictly positive so
///     proportional math stays sane.
///
/// COMP-0 — every ingredient now belongs to exactly one
/// <see cref="RecipeComponent"/>. The aggregate's
/// <see cref="Recipe.ReplaceComponents"/> method is responsible for
/// guaranteeing that the <see cref="ComponentId"/> references a component
/// whose <see cref="RecipeComponent.RecipeId"/> matches this ingredient's
/// <see cref="RecipeId"/>; the FK + the <see cref="AppDbContext"/> config
/// harden that invariant at the persistence layer as well.
/// </summary>
public class Ingredient
{
    public const int NameMaxLength = 200;
    public const int UnitMaxLength = 40;
    public const int NoteMaxLength = 200;

    // EF-friendly parameterless ctor — private so domain construction goes
    // through the validating ctor below.
    private Ingredient() { }

    public Ingredient(
        Guid recipeId,
        Guid componentId,
        int position,
        decimal? quantity,
        string unit,
        string name,
        string? note,
        bool scalable)
    {
        if (recipeId == Guid.Empty)
            throw new ArgumentException("RecipeId must not be empty.", nameof(recipeId));
        if (componentId == Guid.Empty)
            throw new ArgumentException("ComponentId must not be empty.", nameof(componentId));
        if (position < 0)
            throw new ArgumentException("Position must not be negative.", nameof(position));

        if (string.IsNullOrWhiteSpace(name))
            throw new ArgumentException("Ingredient name must not be blank.", nameof(name));
        var trimmedName = name.Trim();
        if (trimmedName.Length > NameMaxLength)
            throw new ArgumentException(
                $"Ingredient name must be at most {NameMaxLength} characters.", nameof(name));

        var safeUnit = unit ?? string.Empty;
        if (safeUnit.Length > UnitMaxLength)
            throw new ArgumentException(
                $"Unit must be at most {UnitMaxLength} characters.", nameof(unit));

        string? normalizedNote = null;
        if (!string.IsNullOrWhiteSpace(note))
        {
            var trimmedNote = note.Trim();
            if (trimmedNote.Length > NoteMaxLength)
                throw new ArgumentException(
                    $"Note must be at most {NoteMaxLength} characters.", nameof(note));
            normalizedNote = trimmedNote;
        }

        // Scalability invariants.
        if (scalable)
        {
            if (quantity is null || quantity.Value <= 0m)
                throw new ArgumentException(
                    "Scalable ingredients must have a quantity greater than zero.", nameof(quantity));
        }
        else
        {
            // Unscalable is always fine — quantity null ("nach Geschmack") or
            // a fixed value ("1 Prise") are both valid.
        }

        if (quantity is null && scalable)
            throw new ArgumentException(
                "\"Nach Geschmack\" entries (quantity null) cannot be scalable.", nameof(scalable));

        Id = Guid.NewGuid();
        RecipeId = recipeId;
        ComponentId = componentId;
        Position = position;
        Quantity = quantity;
        Unit = safeUnit;
        Name = trimmedName;
        Note = normalizedNote;
        Scalable = scalable;
    }

    public Guid Id { get; private set; }
    public Guid RecipeId { get; private set; }
    public Guid ComponentId { get; private set; }
    public int Position { get; private set; }
    public decimal? Quantity { get; private set; }
    public string Unit { get; private set; } = string.Empty;
    public string Name { get; private set; } = string.Empty;
    public string? Note { get; private set; }
    public bool Scalable { get; private set; }
}
