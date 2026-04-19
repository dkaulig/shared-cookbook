using FamilienKochbuch.Domain.Entities;
using Xunit;

namespace FamilienKochbuch.Domain.Tests.Entities;

/// <summary>
/// PF1 — invariants for the <see cref="StagedPhoto"/> aggregate.
///
/// A staged photo represents an upload that has been pushed into
/// SeaweedFS via <c>POST /api/recipes/photos/staged</c> but is not yet
/// attached to a real recipe. The row tracks ownership (so the promote
/// flow can verify the caller actually uploaded it), the storage key
/// (so the sweep job can reach the blob), and the promotion lifecycle
/// (so we never double-promote).
/// </summary>
public class StagedPhotoTests
{
    private static StagedPhoto NewStagedPhoto(
        Guid? userId = null,
        string photoId = "recipes/abc123.jpg",
        string signedUrl = "/api/photos/recipes/abc123.jpg?sig=x&exp=9",
        string contentType = "image/jpeg",
        DateTimeOffset? createdAt = null) =>
        new(
            userId: userId ?? Guid.NewGuid(),
            photoId: photoId,
            signedUrl: signedUrl,
            contentType: contentType,
            createdAt: createdAt ?? DateTimeOffset.UtcNow);

    [Fact]
    public void Constructor_Sets_Defaults_With_Null_Promotion()
    {
        var now = DateTimeOffset.UtcNow;
        var userId = Guid.NewGuid();

        var staged = new StagedPhoto(
            userId: userId,
            photoId: "recipes/photo-1.jpg",
            signedUrl: "/api/photos/recipes/photo-1.jpg?sig=abc&exp=1",
            contentType: "image/jpeg",
            createdAt: now);

        Assert.NotEqual(Guid.Empty, staged.Id);
        Assert.Equal(userId, staged.UserId);
        Assert.Equal("recipes/photo-1.jpg", staged.PhotoId);
        Assert.Equal("/api/photos/recipes/photo-1.jpg?sig=abc&exp=1", staged.SignedUrl);
        Assert.Equal("image/jpeg", staged.ContentType);
        Assert.Equal(now, staged.CreatedAt);
        Assert.Null(staged.PromotedAt);
        Assert.Null(staged.PromotedToRecipeId);
    }

    [Fact]
    public void Constructor_Rejects_Empty_UserId()
    {
        Assert.Throws<ArgumentException>(() => new StagedPhoto(
            userId: Guid.Empty,
            photoId: "recipes/x.jpg",
            signedUrl: "/api/photos/recipes/x.jpg",
            contentType: "image/jpeg",
            createdAt: DateTimeOffset.UtcNow));
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void Constructor_Rejects_Blank_PhotoId(string photoId)
    {
        Assert.Throws<ArgumentException>(() => new StagedPhoto(
            userId: Guid.NewGuid(),
            photoId: photoId,
            signedUrl: "/api/photos/recipes/x.jpg",
            contentType: "image/jpeg",
            createdAt: DateTimeOffset.UtcNow));
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void Constructor_Rejects_Blank_SignedUrl(string signedUrl)
    {
        Assert.Throws<ArgumentException>(() => new StagedPhoto(
            userId: Guid.NewGuid(),
            photoId: "recipes/x.jpg",
            signedUrl: signedUrl,
            contentType: "image/jpeg",
            createdAt: DateTimeOffset.UtcNow));
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void Constructor_Rejects_Blank_ContentType(string contentType)
    {
        Assert.Throws<ArgumentException>(() => new StagedPhoto(
            userId: Guid.NewGuid(),
            photoId: "recipes/x.jpg",
            signedUrl: "/api/photos/recipes/x.jpg",
            contentType: contentType,
            createdAt: DateTimeOffset.UtcNow));
    }

    [Fact]
    public void Constructor_Trims_PhotoId_And_SignedUrl_And_ContentType()
    {
        var staged = NewStagedPhoto(
            photoId: "  recipes/abc.jpg  ",
            signedUrl: "  /api/photos/recipes/abc.jpg  ",
            contentType: "  image/jpeg  ");

        Assert.Equal("recipes/abc.jpg", staged.PhotoId);
        Assert.Equal("/api/photos/recipes/abc.jpg", staged.SignedUrl);
        Assert.Equal("image/jpeg", staged.ContentType);
    }

    [Fact]
    public void MarkPromoted_Sets_PromotedAt_And_RecipeId_Once()
    {
        var staged = NewStagedPhoto();
        var recipeId = Guid.NewGuid();
        var promotedAt = DateTimeOffset.UtcNow;

        staged.MarkPromoted(recipeId, promotedAt);

        Assert.Equal(recipeId, staged.PromotedToRecipeId);
        Assert.Equal(promotedAt, staged.PromotedAt);
    }

    [Fact]
    public void MarkPromoted_Rejects_Empty_RecipeId()
    {
        var staged = NewStagedPhoto();
        Assert.Throws<ArgumentException>(() =>
            staged.MarkPromoted(Guid.Empty, DateTimeOffset.UtcNow));
    }

    [Fact]
    public void MarkPromoted_Twice_Throws()
    {
        var staged = NewStagedPhoto();
        var firstRecipe = Guid.NewGuid();
        staged.MarkPromoted(firstRecipe, DateTimeOffset.UtcNow);

        // Already promoted — second call must throw, not silently overwrite.
        Assert.Throws<InvalidOperationException>(() =>
            staged.MarkPromoted(Guid.NewGuid(), DateTimeOffset.UtcNow));

        // First promotion remains the source of truth.
        Assert.Equal(firstRecipe, staged.PromotedToRecipeId);
    }
}
