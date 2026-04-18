namespace FamilienKochbuch.Infrastructure;

/// <summary>
/// Assembly marker for <c>FamilienKochbuch.Infrastructure</c>.
/// Exists so the smoke test (and any future assembly-scanning code such as
/// EF <c>IEntityTypeConfiguration</c> discovery or DI module registration)
/// has a stable, trivially-reachable type to anchor on. Do not rename —
/// the smoke test asserts the exact string.
/// </summary>
public static class InfrastructureMarker
{
    public const string Name = "FamilienKochbuch.Infrastructure";
}
