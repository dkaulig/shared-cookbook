using SharedCookbook.Domain.Common;
using SharedCookbook.Domain.Entities;
using Xunit;

namespace SharedCookbook.Domain.Tests.Entities;

/// <summary>
/// OFF3: asserts <see cref="Group"/> implements
/// <see cref="IVersionedEntity"/> and every public mutation method
/// bumps <see cref="Group.Version"/> exactly once.
/// </summary>
public class GroupVersionTests
{
    private static Group NewGroup() =>
        new("Kochbuch", null, DateTimeOffset.UtcNow);

    [Fact]
    public void Implements_IVersionedEntity()
    {
        Assert.IsAssignableFrom<IVersionedEntity>(NewGroup());
    }

    [Fact]
    public void Constructor_Initialises_Version_To_Zero()
    {
        Assert.Equal(0, NewGroup().Version);
    }

    [Fact]
    public void UpdateMetadata_Bumps_Version_Once_Per_Call()
    {
        var g = NewGroup();
        var before = g.Version;

        g.UpdateMetadata("Neue Familie", description: null, defaultServings: null, coverImageUrl: null);

        Assert.Equal(before + 1, g.Version);
    }

    [Fact]
    public void UpdateMetadata_Bumps_Once_Even_With_Multiple_Fields()
    {
        var g = NewGroup();
        var before = g.Version;

        g.UpdateMetadata(
            name: "Neu",
            description: "Beschreibung",
            defaultServings: 4m,
            coverImageUrl: "https://cdn/x.jpg");

        Assert.Equal(before + 1, g.Version);
    }

    [Fact]
    public void SoftDelete_Bumps_Version_Once()
    {
        var g = NewGroup();
        var before = g.Version;

        g.SoftDelete(DateTimeOffset.UtcNow);

        Assert.Equal(before + 1, g.Version);
    }

    [Fact]
    public void Multiple_Mutations_Accumulate()
    {
        var g = NewGroup();

        g.UpdateMetadata("A", null, null, null);
        g.UpdateMetadata("B", null, null, null);
        g.UpdateMetadata("C", null, null, null);

        Assert.Equal(3, g.Version);
    }
}
