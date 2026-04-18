using FamilienKochbuch.Domain.Entities;
using Xunit;

namespace FamilienKochbuch.Domain.Tests.Entities;

/// <summary>
/// Invariants for the <see cref="AppInvite"/> aggregate — covers the
/// "valid/expired/used" state machine that signup endpoints rely on.
/// </summary>
public class AppInviteTests
{
    // Exactly 64 chars — pads with 'x' so the token-length invariant can be
    // tested separately via the dedicated test below.
    private const string ValidToken =
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    private static AppInvite NewInvite(
        string token = ValidToken,
        DateTimeOffset? createdAt = null,
        DateTimeOffset? expiresAt = null,
        string? email = null)
    {
        var now = createdAt ?? DateTimeOffset.UtcNow;
        return new AppInvite(
            token: token,
            createdByUserId: Guid.NewGuid(),
            email: email,
            createdAt: now,
            expiresAt: expiresAt ?? now.AddDays(14));
    }

    [Fact]
    public void Ctor_Requires_Token_Of_Exactly_64_Chars()
    {
        var shortToken = new string('a', 63);
        var longToken = new string('a', 65);

        Assert.Throws<ArgumentException>(() => NewInvite(token: shortToken));
        Assert.Throws<ArgumentException>(() => NewInvite(token: longToken));
    }

    [Fact]
    public void Ctor_Requires_ExpiresAt_After_CreatedAt()
    {
        var now = DateTimeOffset.UtcNow;

        Assert.Throws<ArgumentException>(() =>
            NewInvite(createdAt: now, expiresAt: now));
        Assert.Throws<ArgumentException>(() =>
            NewInvite(createdAt: now, expiresAt: now.AddMinutes(-1)));
    }

    [Fact]
    public void Ctor_Lowercases_Email_When_Provided()
    {
        var invite = NewInvite(email: "NEW.USER@Example.COM");

        Assert.Equal("new.user@example.com", invite.Email);
    }

    [Fact]
    public void IsValid_True_When_Unused_And_Unexpired()
    {
        var now = DateTimeOffset.UtcNow;
        var invite = NewInvite(createdAt: now, expiresAt: now.AddDays(14));

        Assert.True(invite.IsValid(now.AddMinutes(1)));
    }

    [Fact]
    public void IsValid_False_When_Expired()
    {
        var now = DateTimeOffset.UtcNow;
        var invite = NewInvite(createdAt: now, expiresAt: now.AddDays(14));

        Assert.False(invite.IsValid(now.AddDays(15)));
    }

    [Fact]
    public void IsValid_False_When_Already_Used()
    {
        var now = DateTimeOffset.UtcNow;
        var invite = NewInvite(createdAt: now, expiresAt: now.AddDays(14));
        invite.MarkUsed(Guid.NewGuid(), now.AddMinutes(30));

        Assert.False(invite.IsValid(now.AddMinutes(31)));
    }

    [Fact]
    public void IsValid_False_At_Exact_Expiration_Instant()
    {
        var now = DateTimeOffset.UtcNow;
        var invite = NewInvite(createdAt: now, expiresAt: now.AddDays(14));

        Assert.False(invite.IsValid(now.AddDays(14)));
    }

    [Fact]
    public void MarkUsed_Records_User_And_Timestamp()
    {
        var invite = NewInvite();
        var userId = Guid.NewGuid();
        var usedAt = DateTimeOffset.UtcNow;

        invite.MarkUsed(userId, usedAt);

        Assert.Equal(userId, invite.UsedByUserId);
        Assert.Equal(usedAt, invite.UsedAt);
    }

    [Fact]
    public void MarkUsed_Twice_Throws()
    {
        var invite = NewInvite();
        invite.MarkUsed(Guid.NewGuid(), DateTimeOffset.UtcNow);

        Assert.Throws<InvalidOperationException>(() =>
            invite.MarkUsed(Guid.NewGuid(), DateTimeOffset.UtcNow));
    }
}
