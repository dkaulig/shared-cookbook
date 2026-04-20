using FamilienKochbuch.Domain.Entities;
using Xunit;

namespace FamilienKochbuch.Domain.Tests.Entities;

/// <summary>
/// CR1 — invariants for <see cref="ChatSession"/>. Sessions are owned
/// by a single user, auto-timestamped, and carry the denormalised
/// <c>MessageCount</c> + <c>UpdatedAt</c> that power the sessions-list
/// UI without a JOIN onto messages.
/// </summary>
public class ChatSessionTests
{
    [Fact]
    public void Create_Sets_Id_And_UserId_And_Timestamps()
    {
        var userId = Guid.NewGuid();
        var now = DateTimeOffset.UtcNow;

        var session = ChatSession.Create(userId, now);

        Assert.NotEqual(Guid.Empty, session.Id);
        Assert.Equal(userId, session.UserId);
        Assert.Null(session.Title);
        Assert.Equal(0, session.MessageCount);
        Assert.Equal(now, session.CreatedAt);
        Assert.Equal(now, session.UpdatedAt);
    }

    [Fact]
    public void Create_Throws_For_Empty_UserId()
    {
        Assert.Throws<ArgumentException>(() =>
            ChatSession.Create(Guid.Empty, DateTimeOffset.UtcNow));
    }

    [Fact]
    public void Rename_Updates_Title_And_UpdatedAt()
    {
        var created = DateTimeOffset.UtcNow;
        var later = created.AddMinutes(5);
        var session = ChatSession.Create(Guid.NewGuid(), created);

        session.Rename("Nudelrezepte", later);

        Assert.Equal("Nudelrezepte", session.Title);
        Assert.Equal(later, session.UpdatedAt);
        // CreatedAt is immutable — only the activity timestamp moves.
        Assert.Equal(created, session.CreatedAt);
    }

    [Fact]
    public void Rename_Trims_Whitespace()
    {
        var session = ChatSession.Create(Guid.NewGuid(), DateTimeOffset.UtcNow);

        session.Rename("  Kürbissuppe  ", DateTimeOffset.UtcNow);

        Assert.Equal("Kürbissuppe", session.Title);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("\t\n")]
    public void Rename_Throws_On_Empty_Or_Whitespace(string title)
    {
        var session = ChatSession.Create(Guid.NewGuid(), DateTimeOffset.UtcNow);

        Assert.Throws<ArgumentException>(() =>
            session.Rename(title, DateTimeOffset.UtcNow));
    }

    [Fact]
    public void Rename_Throws_On_Null()
    {
        var session = ChatSession.Create(Guid.NewGuid(), DateTimeOffset.UtcNow);

        // IsNullOrWhiteSpace handles null up-front → ArgumentException
        // (not ArgumentNullException) keeps the public contract simple.
        Assert.Throws<ArgumentException>(() =>
            session.Rename(null!, DateTimeOffset.UtcNow));
    }

    [Fact]
    public void Rename_Throws_When_Title_Exceeds_Limit()
    {
        var session = ChatSession.Create(Guid.NewGuid(), DateTimeOffset.UtcNow);
        var tooLong = new string('x', ChatSession.TitleMaxLength + 1);

        Assert.Throws<ArgumentException>(() =>
            session.Rename(tooLong, DateTimeOffset.UtcNow));
    }

    [Fact]
    public void RecordMessageAdded_Increments_Count_And_Bumps_UpdatedAt()
    {
        var created = DateTimeOffset.UtcNow;
        var session = ChatSession.Create(Guid.NewGuid(), created);
        var firstAdd = created.AddSeconds(10);
        var secondAdd = created.AddSeconds(20);

        session.RecordMessageAdded(firstAdd);
        Assert.Equal(1, session.MessageCount);
        Assert.Equal(firstAdd, session.UpdatedAt);

        session.RecordMessageAdded(secondAdd);
        Assert.Equal(2, session.MessageCount);
        Assert.Equal(secondAdd, session.UpdatedAt);
        // CreatedAt never moves.
        Assert.Equal(created, session.CreatedAt);
    }
}
