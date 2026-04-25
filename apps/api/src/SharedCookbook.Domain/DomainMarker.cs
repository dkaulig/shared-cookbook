namespace SharedCookbook.Domain;

/// <summary>
/// Assembly marker for <c>SharedCookbook.Domain</c>.
/// Exists so the smoke test (and any future assembly-scanning code such as
/// MediatR/AutoMapper registration) has a stable, trivially-reachable type
/// to anchor on. Do not rename — the smoke test asserts the exact string.
/// </summary>
public static class DomainMarker
{
    public const string Name = "SharedCookbook.Domain";
}
