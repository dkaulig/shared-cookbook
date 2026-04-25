namespace SharedCookbook.Domain.Enums;

/// <summary>
/// Application-level role for a <c>User</c>. A separate, orthogonal concept
/// from <c>GroupMembership.Role</c> (which lives per-group in S2).
/// </summary>
public enum UserRole
{
    /// <summary>Default role — normal user with access to their own groups.</summary>
    User = 0,

    /// <summary>Global admin — can revoke invites, manage other users, and
    /// perform system-level actions (seeded on first boot via env vars).</summary>
    Admin = 1,
}
