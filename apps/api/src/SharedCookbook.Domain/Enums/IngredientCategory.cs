namespace SharedCookbook.Domain.Enums;

/// <summary>
/// Supermarket aisle bucket for a <see cref="MealPlanning.ShoppingListItem"/>.
/// Explicit integer values are part of the storage contract — the EF
/// configuration stores this enum as <c>int</c>, so the numeric mapping
/// MUST stay stable across releases. New categories are appended with
/// fresh integers rather than reshuffling; deprecations are marked but
/// kept around until a migration backfills existing rows.
///
/// Extended in P3-6 (§Architectural-decisions decision #5, hybrid
/// static map first, LLM-fallback for "Sonstiges" items on demand). The
/// static <see cref="Api.Services.IngredientCategorizer"/> maps German
/// ingredient names into these buckets; unknown names land in
/// <see cref="Sonstiges"/> until the user triggers an LLM recategorize.
/// </summary>
public enum IngredientCategory
{
    /// <summary>Fallback bucket for anything not yet known.</summary>
    Sonstiges = 0,

    /// <summary>Obst &amp; Gemüse — Tomate, Apfel, Salat, Zwiebel, …</summary>
    ObstGemuese = 1,

    /// <summary>Trockenwaren — Mehl, Reis, Nudeln, Linsen, Zucker, Salz.</summary>
    Trockenwaren = 2,

    /// <summary>Gewürze — Pfeffer, Paprikapulver, Oregano, Curry, …</summary>
    Gewuerze = 3,

    /// <summary>Molkerei — Milch, Joghurt, Butter, Käse, Sahne, Quark.</summary>
    Molkerei = 4,

    /// <summary>Fleisch &amp; Fisch — Hackfleisch, Hähnchen, Lachs, Speck.</summary>
    FleischFisch = 5,

    /// <summary>Backen &amp; Süßes — Backpulver, Hefe, Schokolade, Vanille.</summary>
    BackenSuess = 6,

    /// <summary>Konserven &amp; Fertigprodukte — Dosentomaten, Kokosmilch,
    /// Tomatenmark, Brühe, Senf, Mayonnaise.</summary>
    KonservenFertig = 7,

    /// <summary>Getränke &amp; Öle — Olivenöl, Essig, Sojasauce, Wein.</summary>
    GetraenkeOele = 8,

    /// <summary>Tiefkühl &amp; Brot — TK-Erbsen, Toastbrot, Fladenbrot, Pita.</summary>
    TiefkuehlBrot = 9,

    /// <summary>Haushalt — Folie, Spülmittel, Klopapier (user-added only).</summary>
    Haushalt = 10,
}
