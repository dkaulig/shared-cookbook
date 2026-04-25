using SharedCookbook.Domain.Entities;
using SharedCookbook.Domain.Enums;
using Xunit;

namespace SharedCookbook.Domain.Tests.Entities;

/// <summary>
/// Invariants for <see cref="GroupMembership"/>. Composite PK
/// (UserId, GroupId) — a user can be in many groups and a group has many
/// users; (user, group) pair is unique.
/// </summary>
public class GroupMembershipTests
{
    [Fact]
    public void Constructor_Sets_Fields_And_JoinedAt()
    {
        var userId = Guid.NewGuid();
        var groupId = Guid.NewGuid();
        var now = DateTimeOffset.UtcNow;

        var membership = new GroupMembership(userId, groupId, GroupRole.Admin, now);

        Assert.Equal(userId, membership.UserId);
        Assert.Equal(groupId, membership.GroupId);
        Assert.Equal(GroupRole.Admin, membership.Role);
        Assert.Equal(now, membership.JoinedAt);
    }

    [Fact]
    public void Two_Users_Can_Be_In_Same_Group()
    {
        var groupId = Guid.NewGuid();
        var userA = Guid.NewGuid();
        var userB = Guid.NewGuid();
        var now = DateTimeOffset.UtcNow;

        var mA = new GroupMembership(userA, groupId, GroupRole.Admin, now);
        var mB = new GroupMembership(userB, groupId, GroupRole.Member, now);

        // Composite-key sanity: same group, different users → different identity tuples.
        Assert.Equal(mA.GroupId, mB.GroupId);
        Assert.NotEqual(mA.UserId, mB.UserId);
    }

    [Fact]
    public void Same_User_Can_Be_In_Two_Groups()
    {
        var userId = Guid.NewGuid();
        var groupA = Guid.NewGuid();
        var groupB = Guid.NewGuid();
        var now = DateTimeOffset.UtcNow;

        var mA = new GroupMembership(userId, groupA, GroupRole.Admin, now);
        var mB = new GroupMembership(userId, groupB, GroupRole.Member, now);

        Assert.Equal(mA.UserId, mB.UserId);
        Assert.NotEqual(mA.GroupId, mB.GroupId);
    }

    [Fact]
    public void Constructor_Rejects_Empty_UserId()
    {
        Assert.Throws<ArgumentException>(() =>
            new GroupMembership(Guid.Empty, Guid.NewGuid(), GroupRole.Member, DateTimeOffset.UtcNow));
    }

    [Fact]
    public void Constructor_Rejects_Empty_GroupId()
    {
        Assert.Throws<ArgumentException>(() =>
            new GroupMembership(Guid.NewGuid(), Guid.Empty, GroupRole.Member, DateTimeOffset.UtcNow));
    }

    [Fact]
    public void ChangeRole_Updates_Role()
    {
        var m = new GroupMembership(Guid.NewGuid(), Guid.NewGuid(), GroupRole.Member, DateTimeOffset.UtcNow);

        m.ChangeRole(GroupRole.Admin);

        Assert.Equal(GroupRole.Admin, m.Role);
    }
}
