using SharedCookbook.Domain.Enums;

namespace SharedCookbook.Domain.Entities;

/// <summary>
/// Join record linking a <see cref="User"/> to a <see cref="Group"/>. Uses
/// a composite primary key (UserId, GroupId) so each pair exists at most
/// once. Role is mutable via <see cref="ChangeRole"/> (Admin only in the
/// endpoint layer).
/// </summary>
public class GroupMembership
{
    // EF-friendly parameterless ctor — private so domain construction goes
    // through the validating ctor below.
    private GroupMembership() { }

    public GroupMembership(Guid userId, Guid groupId, GroupRole role, DateTimeOffset joinedAt)
    {
        if (userId == Guid.Empty)
            throw new ArgumentException("UserId must not be empty.", nameof(userId));
        if (groupId == Guid.Empty)
            throw new ArgumentException("GroupId must not be empty.", nameof(groupId));

        UserId = userId;
        GroupId = groupId;
        Role = role;
        JoinedAt = joinedAt;
    }

    public Guid UserId { get; private set; }

    public Guid GroupId { get; private set; }

    public GroupRole Role { get; private set; }

    public DateTimeOffset JoinedAt { get; private set; }

    public void ChangeRole(GroupRole role)
    {
        Role = role;
    }
}
