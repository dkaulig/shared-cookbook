namespace FamilienKochbuch.Domain.Enums;

/// <summary>
/// How a recipe originally entered the collection. Phase 1 uses only
/// <see cref="Manual"/>; the AI-driven values are present on the enum from
/// day one so S2's domain and S3 migration can freeze the column schema.
/// (PRD §8.3.)
/// </summary>
public enum RecipeSourceType
{
    Manual = 0,
    Video = 1,
    Chat = 2,
    Photo = 3,
}
