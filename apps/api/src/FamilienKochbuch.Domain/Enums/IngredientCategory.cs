namespace FamilienKochbuch.Domain.Enums;

/// <summary>
/// Supermarket aisle bucket for a <see cref="MealPlanning.ShoppingListItem"/>
/// (P3-5/P3-6). P3-5 ships the minimal enum with only <see cref="Sonstiges"/>
/// because the P3-5 aggregator cannot yet categorize on its own — every
/// generated item defaults to Sonstiges. P3-6 expands the enum with the full
/// supermarket categories (Obst/Gemüse, Milchprodukte, …) and a static
/// zutat→category map; existing rows created by P3-5 stay valid because the
/// Sonstiges = 0 value is pinned as a stable storage contract.
/// </summary>
public enum IngredientCategory
{
    /// <summary>Fallback bucket for anything not yet known.</summary>
    Sonstiges = 0,
}
