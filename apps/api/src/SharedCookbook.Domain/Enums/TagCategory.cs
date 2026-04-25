namespace SharedCookbook.Domain.Enums;

/// <summary>
/// PRD §4.2 tag taxonomy. Seeded global tags cover the predefined
/// categories; <see cref="Custom"/> is reserved for user-created,
/// group-scoped tags (S4 brings CRUD for these — in S3 only the enum and
/// storage shape exist).
///
/// <para>
/// GR1 (2026-04-18) introduced <see cref="Komponente"/> for isolated
/// sub-recipes (Pizzateig, Tomatensauce, Dressings, Glasuren …). It is
/// declared in source between <see cref="Kueche"/> and <see cref="Custom"/>
/// so the predefined categories stay grouped, but its integer value is 7
/// — <see cref="Custom"/> keeps the original value 6 so existing Custom
/// rows in production databases are not silently re-categorized.
/// </para>
/// </summary>
public enum TagCategory
{
    Mahlzeit = 0,
    Saison = 1,
    Typ = 2,
    Aufwand = 3,
    Diaet = 4,
    Kueche = 5,
    Komponente = 7,
    Custom = 6,
}
