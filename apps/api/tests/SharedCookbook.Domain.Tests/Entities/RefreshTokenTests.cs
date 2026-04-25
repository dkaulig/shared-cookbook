using SharedCookbook.Domain.Entities;
using Xunit;

namespace SharedCookbook.Domain.Tests.Entities;

/// <summary>
/// Invariants for the <see cref="RefreshToken"/> aggregate — the rotation
/// and revocation lifecycle the auth service relies on for silent refresh.
/// </summary>
public class RefreshTokenTests
{
    private static RefreshToken NewToken(
        DateTimeOffset? issuedAt = null,
        DateTimeOffset? expiresAt = null)
    {
        var issued = issuedAt ?? DateTimeOffset.UtcNow;
        return new RefreshToken(
            userId: Guid.NewGuid(),
            tokenHash: new string('h', 64),
            issuedAt: issued,
            expiresAt: expiresAt ?? issued.AddDays(30));
    }

    [Fact]
    public void Ctor_Requires_Non_Empty_Hash()
    {
        var now = DateTimeOffset.UtcNow;
        Assert.Throws<ArgumentException>(() => new RefreshToken(
            userId: Guid.NewGuid(),
            tokenHash: "",
            issuedAt: now,
            expiresAt: now.AddDays(30)));
    }

    [Fact]
    public void Ctor_Requires_Expiry_After_Issuance()
    {
        var now = DateTimeOffset.UtcNow;
        Assert.Throws<ArgumentException>(() => new RefreshToken(
            userId: Guid.NewGuid(),
            tokenHash: "abc",
            issuedAt: now,
            expiresAt: now));
    }

    [Fact]
    public void IsActive_True_When_Fresh()
    {
        var now = DateTimeOffset.UtcNow;
        var token = NewToken(issuedAt: now, expiresAt: now.AddDays(30));

        Assert.True(token.IsActive(now.AddHours(1)));
    }

    [Fact]
    public void IsActive_False_Once_Expired()
    {
        var now = DateTimeOffset.UtcNow;
        var token = NewToken(issuedAt: now, expiresAt: now.AddDays(30));

        Assert.False(token.IsActive(now.AddDays(31)));
    }

    [Fact]
    public void IsActive_False_At_Exact_Expiration_Instant()
    {
        var now = DateTimeOffset.UtcNow;
        var token = NewToken(issuedAt: now, expiresAt: now.AddDays(30));

        Assert.False(token.IsActive(now.AddDays(30)));
    }

    [Fact]
    public void IsActive_False_After_Rotation()
    {
        var now = DateTimeOffset.UtcNow;
        var token = NewToken(issuedAt: now, expiresAt: now.AddDays(30));
        var replacement = Guid.NewGuid();

        token.MarkRotated(now.AddMinutes(5), replacement);

        Assert.False(token.IsActive(now.AddMinutes(10)));
        Assert.Equal(now.AddMinutes(5), token.RotatedAt);
        Assert.Equal(replacement, token.ReplacedByTokenId);
    }

    [Fact]
    public void IsActive_False_After_Revoke()
    {
        var now = DateTimeOffset.UtcNow;
        var token = NewToken(issuedAt: now, expiresAt: now.AddDays(30));

        token.Revoke(now.AddHours(1));

        Assert.False(token.IsActive(now.AddHours(2)));
        Assert.Equal(now.AddHours(1), token.RevokedAt);
    }

    [Fact]
    public void MarkRotated_Twice_Throws()
    {
        var now = DateTimeOffset.UtcNow;
        var token = NewToken(issuedAt: now, expiresAt: now.AddDays(30));
        token.MarkRotated(now.AddMinutes(5), Guid.NewGuid());

        Assert.Throws<InvalidOperationException>(() =>
            token.MarkRotated(now.AddMinutes(6), Guid.NewGuid()));
    }

    [Fact]
    public void Revoke_Is_Idempotent_And_Keeps_First_Timestamp()
    {
        var now = DateTimeOffset.UtcNow;
        var token = NewToken(issuedAt: now, expiresAt: now.AddDays(30));

        token.Revoke(now.AddHours(1));
        token.Revoke(now.AddHours(2));

        Assert.Equal(now.AddHours(1), token.RevokedAt);
    }

    [Fact]
    public void Revoke_After_Rotation_Still_Sets_RevokedAt()
    {
        var now = DateTimeOffset.UtcNow;
        var token = NewToken(issuedAt: now, expiresAt: now.AddDays(30));
        token.MarkRotated(now.AddMinutes(5), Guid.NewGuid());

        token.Revoke(now.AddMinutes(10));

        Assert.Equal(now.AddMinutes(10), token.RevokedAt);
    }
}
