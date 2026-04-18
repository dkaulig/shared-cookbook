using FamilienKochbuch.Domain.Enums;

namespace FamilienKochbuch.Domain.Entities;

/// <summary>
/// In-app invitation of an existing <see cref="User"/> into a
/// <see cref="Group"/>. No URL/token — the invited user sees it in the app
/// directly and Accepts/Declines. Only one Pending invite per
/// (group, invitedUser) is permitted at a time; that uniqueness is
/// enforced by a filtered unique index at the infrastructure layer.
/// </summary>
public class GroupInvite
{
    // EF-friendly parameterless ctor — private so domain construction goes
    // through the validating ctor below.
    private GroupInvite() { }

    public GroupInvite(
        Guid groupId,
        Guid invitedByUserId,
        Guid invitedUserId,
        DateTimeOffset createdAt)
    {
        if (groupId == Guid.Empty)
            throw new ArgumentException("GroupId must not be empty.", nameof(groupId));
        if (invitedByUserId == Guid.Empty)
            throw new ArgumentException("InvitedByUserId must not be empty.", nameof(invitedByUserId));
        if (invitedUserId == Guid.Empty)
            throw new ArgumentException("InvitedUserId must not be empty.", nameof(invitedUserId));
        if (invitedByUserId == invitedUserId)
            throw new ArgumentException(
                "A user cannot invite themselves.", nameof(invitedUserId));

        Id = Guid.NewGuid();
        GroupId = groupId;
        InvitedByUserId = invitedByUserId;
        InvitedUserId = invitedUserId;
        Status = InviteStatus.Pending;
        CreatedAt = createdAt;
    }

    public Guid Id { get; private set; }

    public Guid GroupId { get; private set; }

    public Guid InvitedByUserId { get; private set; }

    public Guid InvitedUserId { get; private set; }

    public InviteStatus Status { get; private set; }

    public DateTimeOffset CreatedAt { get; private set; }

    public DateTimeOffset? RespondedAt { get; private set; }

    /// <summary>Marks the invite Accepted. Throws unless currently Pending.</summary>
    public void Accept(DateTimeOffset at) => Transition(InviteStatus.Accepted, at);

    /// <summary>Marks the invite Declined. Throws unless currently Pending.</summary>
    public void Decline(DateTimeOffset at) => Transition(InviteStatus.Declined, at);

    private void Transition(InviteStatus target, DateTimeOffset at)
    {
        if (Status != InviteStatus.Pending)
            throw new InvalidOperationException(
                $"Cannot transition invite from {Status} to {target} — only Pending invites can change state.");

        Status = target;
        RespondedAt = at;
    }
}
