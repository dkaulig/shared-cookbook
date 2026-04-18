namespace FamilienKochbuch.Domain.Enums;

/// <summary>
/// PRD §4.2 tag taxonomy. Seeded global tags cover the first six
/// categories; <see cref="Custom"/> is reserved for user-created,
/// group-scoped tags (S4 brings CRUD for these — in S3 only the enum and
/// storage shape exist).
/// </summary>
public enum TagCategory
{
    Mahlzeit = 0,
    Saison = 1,
    Typ = 2,
    Aufwand = 3,
    Diaet = 4,
    Kueche = 5,
    Custom = 6,
}
