using SharedCookbook.Domain.Entities;
using Xunit;

namespace SharedCookbook.Domain.Tests.Entities;

/// <summary>
/// Invariants for the S4 <see cref="Rating"/> entity — PRD §4.3 / §8.3.
/// One rating per (recipe, user); stars 1..5 inclusive; optional trimmed
/// comment bounded to 2000 characters.
/// </summary>
public class RatingTests
{
    private static Rating NewRating(
        int stars = 5,
        string? comment = null,
        DateTimeOffset? createdAt = null)
    {
        return new Rating(
            recipeId: Guid.NewGuid(),
            userId: Guid.NewGuid(),
            stars: stars,
            comment: comment,
            createdAt: createdAt ?? DateTimeOffset.UtcNow);
    }

    [Fact]
    public void Constructor_Sets_Fields_For_Minimal_Input()
    {
        var now = DateTimeOffset.UtcNow;
        var recipeId = Guid.NewGuid();
        var userId = Guid.NewGuid();

        var rating = new Rating(recipeId, userId, 4, null, now);

        Assert.NotEqual(Guid.Empty, rating.Id);
        Assert.Equal(recipeId, rating.RecipeId);
        Assert.Equal(userId, rating.UserId);
        Assert.Equal(4, rating.Stars);
        Assert.Null(rating.Comment);
        Assert.Equal(now, rating.CreatedAt);
        Assert.Equal(now, rating.UpdatedAt);
    }

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(4)]
    [InlineData(5)]
    public void Constructor_Accepts_Stars_In_Range(int stars)
    {
        var rating = NewRating(stars: stars);

        Assert.Equal(stars, rating.Stars);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(6)]
    [InlineData(100)]
    public void Constructor_Rejects_Stars_Out_Of_Range(int invalid)
    {
        Assert.Throws<ArgumentException>(() => NewRating(stars: invalid));
    }

    [Fact]
    public void Constructor_Rejects_Empty_RecipeId()
    {
        Assert.Throws<ArgumentException>(() =>
            new Rating(Guid.Empty, Guid.NewGuid(), 5, null, DateTimeOffset.UtcNow));
    }

    [Fact]
    public void Constructor_Rejects_Empty_UserId()
    {
        Assert.Throws<ArgumentException>(() =>
            new Rating(Guid.NewGuid(), Guid.Empty, 5, null, DateTimeOffset.UtcNow));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void Constructor_Normalizes_Blank_Comment_To_Null(string? blank)
    {
        var rating = NewRating(comment: blank);

        Assert.Null(rating.Comment);
    }

    [Fact]
    public void Constructor_Trims_Comment()
    {
        var rating = NewRating(comment: "  Lecker!  ");

        Assert.Equal("Lecker!", rating.Comment);
    }

    [Fact]
    public void Constructor_Rejects_Comment_Longer_Than_2000_Chars()
    {
        var tooLong = new string('c', 2001);

        Assert.Throws<ArgumentException>(() => NewRating(comment: tooLong));
    }

    [Fact]
    public void Constructor_Accepts_Comment_At_2000_Char_Boundary()
    {
        var boundary = new string('c', 2000);

        var rating = NewRating(comment: boundary);

        Assert.Equal(boundary, rating.Comment);
    }

    [Fact]
    public void UpdateStars_Replaces_Stars_And_Advances_UpdatedAt()
    {
        var created = DateTimeOffset.UtcNow;
        var rating = NewRating(stars: 2, comment: "ok", createdAt: created);
        var later = created.AddHours(3);

        rating.UpdateStars(5, "Perfekt!", later);

        Assert.Equal(5, rating.Stars);
        Assert.Equal("Perfekt!", rating.Comment);
        Assert.Equal(created, rating.CreatedAt);
        Assert.Equal(later, rating.UpdatedAt);
    }

    [Fact]
    public void UpdateStars_Allows_Clearing_Comment_With_Null()
    {
        var rating = NewRating(stars: 3, comment: "mittel");
        rating.UpdateStars(4, null, DateTimeOffset.UtcNow);

        Assert.Null(rating.Comment);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(6)]
    public void UpdateStars_Rejects_Stars_Out_Of_Range(int invalid)
    {
        var rating = NewRating();

        Assert.Throws<ArgumentException>(() =>
            rating.UpdateStars(invalid, null, DateTimeOffset.UtcNow));
    }

    [Fact]
    public void UpdateStars_Rejects_Comment_Longer_Than_2000_Chars()
    {
        var rating = NewRating();
        var tooLong = new string('x', 2001);

        Assert.Throws<ArgumentException>(() =>
            rating.UpdateStars(4, tooLong, DateTimeOffset.UtcNow));
    }
}
