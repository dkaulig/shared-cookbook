using FamilienKochbuch.Domain.Entities;
using Xunit;

namespace FamilienKochbuch.Domain.Tests.Entities;

/// <summary>
/// Invariants for the <see cref="Group"/> aggregate. Groups hold recipe
/// collections and own GroupMemberships. The "Private Sammlung" flag is
/// reserved for the one-per-user private collection, which must never be
/// deletable per PRD §4.4.
/// </summary>
public class GroupTests
{
    [Fact]
    public void Constructor_Sets_Defaults_For_Minimal_Input()
    {
        var now = DateTimeOffset.UtcNow;
        var group = new Group("Example Family", null, now);

        Assert.Equal("Example Family", group.Name);
        Assert.Null(group.Description);
        Assert.Null(group.CoverImageUrl);
        Assert.Equal(2m, group.DefaultServings);
        Assert.False(group.IsPrivateCollection);
        Assert.Equal(now, group.CreatedAt);
        Assert.Null(group.DeletedAt);
        Assert.NotEqual(Guid.Empty, group.Id);
    }

    [Fact]
    public void Constructor_Trims_Name()
    {
        var group = new Group("  Example Family  ", null, DateTimeOffset.UtcNow);

        Assert.Equal("Example Family", group.Name);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData(null)]
    public void Constructor_Rejects_Blank_Name(string? invalid)
    {
        Assert.Throws<ArgumentException>(() => new Group(invalid!, null, DateTimeOffset.UtcNow));
    }

    [Fact]
    public void Constructor_Rejects_Name_Longer_Than_100_Chars()
    {
        var tooLong = new string('x', 101);

        Assert.Throws<ArgumentException>(() => new Group(tooLong, null, DateTimeOffset.UtcNow));
    }

    [Fact]
    public void Constructor_Accepts_Name_At_100_Chars_Boundary()
    {
        var boundary = new string('a', 100);

        var group = new Group(boundary, null, DateTimeOffset.UtcNow);

        Assert.Equal(boundary, group.Name);
    }

    [Fact]
    public void Constructor_Rejects_Description_Longer_Than_500_Chars()
    {
        var tooLong = new string('d', 501);

        Assert.Throws<ArgumentException>(() =>
            new Group("Name", tooLong, DateTimeOffset.UtcNow));
    }

    [Fact]
    public void Constructor_Accepts_Description_At_500_Chars_Boundary()
    {
        var boundary = new string('d', 500);

        var group = new Group("Name", boundary, DateTimeOffset.UtcNow);

        Assert.Equal(boundary, group.Description);
    }

    [Fact]
    public void Constructor_Normalizes_Blank_Description_To_Null()
    {
        var group = new Group("Name", "   ", DateTimeOffset.UtcNow);

        Assert.Null(group.Description);
    }

    [Fact]
    public void Constructor_With_DefaultServings_Below_Zero_Throws()
    {
        Assert.Throws<ArgumentException>(() =>
            new Group("Name", null, DateTimeOffset.UtcNow, defaultServings: 0m));
    }

    [Fact]
    public void Constructor_With_Negative_DefaultServings_Throws()
    {
        Assert.Throws<ArgumentException>(() =>
            new Group("Name", null, DateTimeOffset.UtcNow, defaultServings: -1m));
    }

    [Fact]
    public void Constructor_With_Custom_DefaultServings_Preserves_Value()
    {
        var group = new Group("Name", null, DateTimeOffset.UtcNow, defaultServings: 4.5m);

        Assert.Equal(4.5m, group.DefaultServings);
    }

    [Fact]
    public void CreatePrivateCollection_Produces_Private_Sammlung()
    {
        var now = DateTimeOffset.UtcNow;

        var group = Group.CreatePrivateCollection(now);

        Assert.Equal("Private Sammlung", group.Name);
        Assert.True(group.IsPrivateCollection);
        Assert.Equal(2m, group.DefaultServings);
        Assert.Equal(now, group.CreatedAt);
    }

    [Fact]
    public void SoftDelete_Sets_DeletedAt_On_Regular_Group()
    {
        var group = new Group("Familie", null, DateTimeOffset.UtcNow);
        var deleted = DateTimeOffset.UtcNow.AddMinutes(1);

        group.SoftDelete(deleted);

        Assert.Equal(deleted, group.DeletedAt);
    }

    [Fact]
    public void SoftDelete_Throws_On_Private_Sammlung()
    {
        var group = Group.CreatePrivateCollection(DateTimeOffset.UtcNow);

        Assert.Throws<InvalidOperationException>(() => group.SoftDelete(DateTimeOffset.UtcNow));
    }

    [Fact]
    public void UpdateMetadata_Changes_Name_Description_DefaultServings_And_Cover()
    {
        var group = new Group("Alt", "Beschreibung", DateTimeOffset.UtcNow);

        group.UpdateMetadata(name: "Neu", description: "Updated", defaultServings: 3m, coverImageUrl: "https://example.com/x.jpg");

        Assert.Equal("Neu", group.Name);
        Assert.Equal("Updated", group.Description);
        Assert.Equal(3m, group.DefaultServings);
        Assert.Equal("https://example.com/x.jpg", group.CoverImageUrl);
    }

    [Fact]
    public void UpdateMetadata_Leaves_Unset_Fields_Alone()
    {
        var group = new Group("Familie", "Beschreibung", DateTimeOffset.UtcNow, defaultServings: 3m);

        group.UpdateMetadata(name: null, description: null, defaultServings: null, coverImageUrl: null);

        Assert.Equal("Familie", group.Name);
        Assert.Equal("Beschreibung", group.Description);
        Assert.Equal(3m, group.DefaultServings);
        Assert.Null(group.CoverImageUrl);
    }

    [Fact]
    public void UpdateMetadata_Rejects_Blank_Name()
    {
        var group = new Group("Familie", null, DateTimeOffset.UtcNow);

        Assert.Throws<ArgumentException>(() =>
            group.UpdateMetadata(name: "   ", description: null, defaultServings: null, coverImageUrl: null));
    }

    [Fact]
    public void UpdateMetadata_Rejects_DefaultServings_Below_Zero()
    {
        var group = new Group("Familie", null, DateTimeOffset.UtcNow);

        Assert.Throws<ArgumentException>(() =>
            group.UpdateMetadata(name: null, description: null, defaultServings: 0m, coverImageUrl: null));
    }
}
