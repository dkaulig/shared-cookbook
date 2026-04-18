using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.Enums;
using Xunit;

namespace FamilienKochbuch.Domain.Tests.Entities;

/// <summary>
/// Invariants for the <see cref="User"/> identity aggregate.
/// </summary>
public class UserTests
{
    [Fact]
    public void New_User_Has_Role_User_By_Default()
    {
        var user = new User { DisplayName = "Oma" };

        Assert.Equal(UserRole.User, user.Role);
    }

    [Fact]
    public void SetDisplayName_Trims_Whitespace()
    {
        var user = new User();

        user.SetDisplayName("  Oma Herta  ");

        Assert.Equal("Oma Herta", user.DisplayName);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData(null)]
    public void SetDisplayName_Rejects_Blank(string? invalid)
    {
        var user = new User();

        Assert.Throws<ArgumentException>(() => user.SetDisplayName(invalid!));
    }

    [Fact]
    public void SetDisplayName_Rejects_Longer_Than_80_Chars()
    {
        var user = new User();
        var tooLong = new string('x', 81);

        Assert.Throws<ArgumentException>(() => user.SetDisplayName(tooLong));
    }

    [Fact]
    public void SetDisplayName_Accepts_80_Chars_Boundary()
    {
        var user = new User();
        var boundary = new string('a', 80);

        user.SetDisplayName(boundary);

        Assert.Equal(boundary, user.DisplayName);
    }

    [Fact]
    public void SetEmail_Lowercases_And_Trims()
    {
        var user = new User();

        user.SetEmail("  David.Kaulig@Example.Com  ");

        Assert.Equal("david.kaulig@example.com", user.Email);
    }

    [Theory]
    [InlineData("")]
    [InlineData("not-an-email")]
    [InlineData("@example.com")]
    [InlineData("user@")]
    [InlineData("user@ domain.com")]
    public void SetEmail_Rejects_Invalid_Format(string invalid)
    {
        var user = new User();

        Assert.Throws<ArgumentException>(() => user.SetEmail(invalid));
    }

    [Fact]
    public void New_User_Has_CreatedAt_Close_To_UtcNow()
    {
        var before = DateTimeOffset.UtcNow.AddSeconds(-1);
        var user = new User();
        var after = DateTimeOffset.UtcNow.AddSeconds(1);

        Assert.InRange(user.CreatedAt, before, after);
    }

    [Fact]
    public void New_User_DeletedAt_Is_Null()
    {
        var user = new User();

        Assert.Null(user.DeletedAt);
    }

    [Fact]
    public void MarkDeleted_Sets_DeletedAt()
    {
        var user = new User();
        var now = DateTimeOffset.UtcNow;

        user.MarkDeleted(now);

        Assert.Equal(now, user.DeletedAt);
    }
}
