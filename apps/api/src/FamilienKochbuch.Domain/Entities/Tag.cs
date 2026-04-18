using FamilienKochbuch.Domain.Enums;

namespace FamilienKochbuch.Domain.Entities;

/// <summary>
/// Recipe tag. Two flavours:
///   * <b>Global</b> (seeded): <see cref="CreatedByUserId"/>==null and
///     <see cref="GroupId"/>==null. Shared across every group.
///   * <b>Group-scoped Custom</b> (S4): both ids present, category=
///     <see cref="TagCategory.Custom"/>.
/// Uniqueness on (Name, Category, GroupId) is enforced by the EF index;
/// the factories below guarantee the domain shape of each variant.
/// </summary>
public class Tag
{
    public const int NameMaxLength = 60;

    // EF-friendly parameterless ctor — private so domain construction goes
    // through the factories.
    private Tag() { }

    /// <summary>Seeded, globally-visible tag. Used by the migration's
    /// InsertData calls for the predefined taxonomy. The caller supplies
    /// the stable id so the seeded rows stay idempotent.</summary>
    public static Tag CreateGlobal(string name, TagCategory category, Guid? stableId = null)
    {
        var trimmed = ValidateName(name);

        return new Tag
        {
            Id = stableId ?? Guid.NewGuid(),
            Name = trimmed,
            Category = category,
            CreatedByUserId = null,
            GroupId = null,
        };
    }

    /// <summary>User-created, group-scoped tag. Always has category
    /// <see cref="TagCategory.Custom"/>.</summary>
    public static Tag CreateGroupScoped(Guid createdByUserId, Guid groupId, string name)
    {
        if (createdByUserId == Guid.Empty)
            throw new ArgumentException("CreatedByUserId must not be empty.", nameof(createdByUserId));
        if (groupId == Guid.Empty)
            throw new ArgumentException("GroupId must not be empty.", nameof(groupId));

        var trimmed = ValidateName(name);

        return new Tag
        {
            Id = Guid.NewGuid(),
            Name = trimmed,
            Category = TagCategory.Custom,
            CreatedByUserId = createdByUserId,
            GroupId = groupId,
        };
    }

    public Guid Id { get; private set; }
    public string Name { get; private set; } = string.Empty;
    public TagCategory Category { get; private set; }
    public Guid? CreatedByUserId { get; private set; }
    public Guid? GroupId { get; private set; }

    public bool IsGlobal => CreatedByUserId is null && GroupId is null;

    private static string ValidateName(string name)
    {
        if (string.IsNullOrWhiteSpace(name))
            throw new ArgumentException("Tag name must not be blank.", nameof(name));
        var trimmed = name.Trim();
        if (trimmed.Length > NameMaxLength)
            throw new ArgumentException(
                $"Tag name must be at most {NameMaxLength} characters.", nameof(name));
        return trimmed;
    }
}
