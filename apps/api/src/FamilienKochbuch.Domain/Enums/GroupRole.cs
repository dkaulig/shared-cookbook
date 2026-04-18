namespace FamilienKochbuch.Domain.Enums;

/// <summary>
/// Role of a user within a specific <see cref="FamilienKochbuch.Domain.Entities.Group"/>.
/// Orthogonal to <see cref="UserRole"/> (global). Per PRD §10.6:
/// Admin = manage group meta, members, roles, delete group; Member = create/edit
/// recipes, invite other members, rate recipes.
/// </summary>
public enum GroupRole
{
    Member = 0,
    Admin = 1,
}
