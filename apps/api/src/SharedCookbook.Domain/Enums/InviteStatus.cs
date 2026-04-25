namespace SharedCookbook.Domain.Enums;

/// <summary>
/// Lifecycle states of a <see cref="SharedCookbook.Domain.Entities.GroupInvite"/>.
/// Pending → Accepted / Declined is a one-shot transition per PRD §10.5.
/// </summary>
public enum InviteStatus
{
    Pending = 0,
    Accepted = 1,
    Declined = 2,
}
