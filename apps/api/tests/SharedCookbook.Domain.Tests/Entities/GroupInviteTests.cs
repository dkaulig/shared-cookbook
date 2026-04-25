using SharedCookbook.Domain.Entities;
using SharedCookbook.Domain.Enums;
using Xunit;

namespace SharedCookbook.Domain.Tests.Entities;

/// <summary>
/// State-machine invariants for <see cref="GroupInvite"/>. PRD §10.5:
/// pure in-app — group members invite existing users; invite is Pending
/// until the recipient Accepts or Declines.
/// </summary>
public class GroupInviteTests
{
    private static GroupInvite NewPending(DateTimeOffset? createdAt = null) =>
        new GroupInvite(
            groupId: Guid.NewGuid(),
            invitedByUserId: Guid.NewGuid(),
            invitedUserId: Guid.NewGuid(),
            createdAt: createdAt ?? DateTimeOffset.UtcNow);

    [Fact]
    public void Constructor_Creates_Pending_Invite_With_New_Id()
    {
        var groupId = Guid.NewGuid();
        var invitedBy = Guid.NewGuid();
        var invited = Guid.NewGuid();
        var now = DateTimeOffset.UtcNow;

        var invite = new GroupInvite(groupId, invitedBy, invited, now);

        Assert.NotEqual(Guid.Empty, invite.Id);
        Assert.Equal(groupId, invite.GroupId);
        Assert.Equal(invitedBy, invite.InvitedByUserId);
        Assert.Equal(invited, invite.InvitedUserId);
        Assert.Equal(InviteStatus.Pending, invite.Status);
        Assert.Equal(now, invite.CreatedAt);
        Assert.Null(invite.RespondedAt);
    }

    [Fact]
    public void Constructor_Rejects_Self_Invite()
    {
        var userId = Guid.NewGuid();

        Assert.Throws<ArgumentException>(() =>
            new GroupInvite(Guid.NewGuid(), userId, userId, DateTimeOffset.UtcNow));
    }

    [Fact]
    public void Constructor_Rejects_Empty_GroupId()
    {
        Assert.Throws<ArgumentException>(() =>
            new GroupInvite(Guid.Empty, Guid.NewGuid(), Guid.NewGuid(), DateTimeOffset.UtcNow));
    }

    [Fact]
    public void Constructor_Rejects_Empty_InvitedUserId()
    {
        Assert.Throws<ArgumentException>(() =>
            new GroupInvite(Guid.NewGuid(), Guid.NewGuid(), Guid.Empty, DateTimeOffset.UtcNow));
    }

    [Fact]
    public void Constructor_Rejects_Empty_InvitedByUserId()
    {
        Assert.Throws<ArgumentException>(() =>
            new GroupInvite(Guid.NewGuid(), Guid.Empty, Guid.NewGuid(), DateTimeOffset.UtcNow));
    }

    [Fact]
    public void Accept_Transitions_Pending_To_Accepted_And_Sets_RespondedAt()
    {
        var invite = NewPending();
        var at = DateTimeOffset.UtcNow.AddMinutes(5);

        invite.Accept(at);

        Assert.Equal(InviteStatus.Accepted, invite.Status);
        Assert.Equal(at, invite.RespondedAt);
    }

    [Fact]
    public void Decline_Transitions_Pending_To_Declined_And_Sets_RespondedAt()
    {
        var invite = NewPending();
        var at = DateTimeOffset.UtcNow.AddMinutes(5);

        invite.Decline(at);

        Assert.Equal(InviteStatus.Declined, invite.Status);
        Assert.Equal(at, invite.RespondedAt);
    }

    [Fact]
    public void Accept_After_Accept_Throws()
    {
        var invite = NewPending();
        invite.Accept(DateTimeOffset.UtcNow);

        Assert.Throws<InvalidOperationException>(() => invite.Accept(DateTimeOffset.UtcNow));
    }

    [Fact]
    public void Accept_After_Decline_Throws()
    {
        var invite = NewPending();
        invite.Decline(DateTimeOffset.UtcNow);

        Assert.Throws<InvalidOperationException>(() => invite.Accept(DateTimeOffset.UtcNow));
    }

    [Fact]
    public void Decline_After_Decline_Throws()
    {
        var invite = NewPending();
        invite.Decline(DateTimeOffset.UtcNow);

        Assert.Throws<InvalidOperationException>(() => invite.Decline(DateTimeOffset.UtcNow));
    }

    [Fact]
    public void Decline_After_Accept_Throws()
    {
        var invite = NewPending();
        invite.Accept(DateTimeOffset.UtcNow);

        Assert.Throws<InvalidOperationException>(() => invite.Decline(DateTimeOffset.UtcNow));
    }
}
