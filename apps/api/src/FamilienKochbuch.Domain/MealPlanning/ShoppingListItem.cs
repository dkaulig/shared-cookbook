using FamilienKochbuch.Domain.Common;
using FamilienKochbuch.Domain.Enums;

namespace FamilienKochbuch.Domain.MealPlanning;

/// <summary>
/// A single line on a <see cref="ShoppingList"/>. Free-text Name + Quantity
/// strings (we do not unit-convert — "200g" stays a string "200g", "1 EL"
/// stays "1 EL") with an optional free-text Unit for well-structured
/// recipes. <see cref="Source"/> captures provenance so the regenerate
/// pipeline (P3-5) can decide what to recompute vs. leave alone.
///
/// Invariants:
/// <list type="bullet">
///   <item>Name 1..200 chars after trim, required.</item>
///   <item>Quantity max 50 chars (null allowed).</item>
///   <item>Unit max 50 chars (null allowed).</item>
///   <item>Note max 500 chars (null allowed).</item>
/// </list>
/// </summary>
public sealed class ShoppingListItem : IVersionedEntity
{
    public const int NameMaxLength = 200;
    public const int QuantityMaxLength = 50;
    public const int UnitMaxLength = 50;
    public const int NoteMaxLength = 500;

    // EF-friendly parameterless ctor.
    private ShoppingListItem() { }

    public ShoppingListItem(
        Guid shoppingListId,
        string name,
        string? quantity,
        string? unit,
        string? note,
        IngredientCategory category,
        ShoppingListItemSource source,
        int sortOrder,
        bool carriedOverFromPreviousWeek,
        DateTimeOffset createdAt)
    {
        if (shoppingListId == Guid.Empty)
            throw new ArgumentException("ShoppingListId must not be empty.", nameof(shoppingListId));

        var normalizedName = ValidateName(name);
        var normalizedQuantity = ValidateOptionalString(quantity, QuantityMaxLength, nameof(quantity));
        var normalizedUnit = ValidateOptionalString(unit, UnitMaxLength, nameof(unit));
        var normalizedNote = ValidateOptionalString(note, NoteMaxLength, nameof(note));

        Id = Guid.NewGuid();
        ShoppingListId = shoppingListId;
        Name = normalizedName;
        Quantity = normalizedQuantity;
        Unit = normalizedUnit;
        Note = normalizedNote;
        Category = category;
        Source = source;
        SortOrder = sortOrder;
        IsChecked = false;
        CarriedOverFromPreviousWeek = carriedOverFromPreviousWeek;
        Version = 0;
        CreatedAt = createdAt;
        UpdatedAt = createdAt;
    }

    public Guid Id { get; private set; }
    public Guid ShoppingListId { get; private set; }
    public string Name { get; private set; } = string.Empty;
    public string? Quantity { get; private set; }
    public string? Unit { get; private set; }
    public string? Note { get; private set; }
    public bool IsChecked { get; private set; }
    public IngredientCategory Category { get; private set; }
    public ShoppingListItemSource Source { get; private set; }
    public int SortOrder { get; private set; }
    public bool CarriedOverFromPreviousWeek { get; private set; }
    public DateTimeOffset CreatedAt { get; private set; }
    public DateTimeOffset UpdatedAt { get; private set; }

    /// <summary>
    /// OFF3 optimistic-concurrency token. Bumped on every mutation
    /// (toggle-check, edit note, reorder, re-categorize). Starts at 0.
    /// </summary>
    public int Version { get; private set; }

    /// <summary>
    /// <see cref="IVersionedEntity.BumpVersion"/>. Each public mutation
    /// invokes this exactly once per state change.
    /// </summary>
    public void BumpVersion() => Version++;

    /// <summary>Toggles the checked flag and refreshes <see cref="UpdatedAt"/>.</summary>
    public void SetChecked(bool isChecked, DateTimeOffset at)
    {
        IsChecked = isChecked;
        UpdatedAt = at;
        BumpVersion();
    }

    /// <summary>Replaces the quantity string. Null clears it.</summary>
    public void SetQuantity(string? quantity, DateTimeOffset at)
    {
        Quantity = ValidateOptionalString(quantity, QuantityMaxLength, nameof(quantity));
        UpdatedAt = at;
        BumpVersion();
    }

    /// <summary>Replaces the unit string. Null clears it.</summary>
    public void SetUnit(string? unit, DateTimeOffset at)
    {
        Unit = ValidateOptionalString(unit, UnitMaxLength, nameof(unit));
        UpdatedAt = at;
        BumpVersion();
    }

    /// <summary>Replaces the free-text note. Null clears it.</summary>
    public void SetNote(string? note, DateTimeOffset at)
    {
        Note = ValidateOptionalString(note, NoteMaxLength, nameof(note));
        UpdatedAt = at;
        BumpVersion();
    }

    /// <summary>Reassigns the within-category ordering hint.</summary>
    public void Reorder(int sortOrder, DateTimeOffset at)
    {
        SortOrder = sortOrder;
        UpdatedAt = at;
        BumpVersion();
    }

    /// <summary>Switches the category bucket — used by P3-6's categorizer.</summary>
    public void SetCategory(IngredientCategory category, DateTimeOffset at)
    {
        Category = category;
        UpdatedAt = at;
        BumpVersion();
    }

    // ── Validation helpers ──────────────────────────────────────────

    private static string ValidateName(string name)
    {
        if (string.IsNullOrWhiteSpace(name))
            throw new ArgumentException("Name must not be blank.", nameof(name));
        var trimmed = name.Trim();
        if (trimmed.Length > NameMaxLength)
            throw new ArgumentException(
                $"Name must be at most {NameMaxLength} characters.", nameof(name));
        return trimmed;
    }

    private static string? ValidateOptionalString(string? value, int maxLength, string paramName)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var trimmed = value.Trim();
        if (trimmed.Length > maxLength)
            throw new ArgumentException(
                $"{paramName} must be at most {maxLength} characters.", paramName);
        return trimmed;
    }
}
