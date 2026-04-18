using FamilienKochbuch.Domain.Enums;
using Xunit;

namespace FamilienKochbuch.Domain.Tests.Entities;

/// <summary>
/// Stable wire values for <see cref="TagCategory"/>. The EF column stores
/// the underlying int, and every seeded migration hard-codes those
/// ordinals (see 20260418101312_AddRecipes.SeedGlobalTags). Reordering any
/// member would silently re-category every row in production, so these
/// tests pin both the membership and the assigned integer for every name.
///
/// GR1 adds <see cref="TagCategory.Komponente"/> at integer value 7,
/// placed in source order between <see cref="TagCategory.Kueche"/> (5)
/// and <see cref="TagCategory.Custom"/>. Custom keeps its original
/// value 6 — existing Custom rows in production must not be
/// re-categorized by this change. Every seeded tag for the Komponente
/// category is written by the AddKomponenteTagCategory migration using
/// the integer 7.
/// </summary>
public class TagCategoryTests
{
    [Fact]
    public void Enum_Has_Eight_Stable_Members()
    {
        var members = Enum.GetValues<TagCategory>();

        Assert.Equal(8, members.Length);
        Assert.Contains(TagCategory.Mahlzeit, members);
        Assert.Contains(TagCategory.Saison, members);
        Assert.Contains(TagCategory.Typ, members);
        Assert.Contains(TagCategory.Aufwand, members);
        Assert.Contains(TagCategory.Diaet, members);
        Assert.Contains(TagCategory.Kueche, members);
        Assert.Contains(TagCategory.Komponente, members);
        Assert.Contains(TagCategory.Custom, members);
    }

    [Theory]
    [InlineData(TagCategory.Mahlzeit, 0)]
    [InlineData(TagCategory.Saison, 1)]
    [InlineData(TagCategory.Typ, 2)]
    [InlineData(TagCategory.Aufwand, 3)]
    [InlineData(TagCategory.Diaet, 4)]
    [InlineData(TagCategory.Kueche, 5)]
    [InlineData(TagCategory.Custom, 6)]
    [InlineData(TagCategory.Komponente, 7)]
    public void Enum_Values_Are_Stable(TagCategory value, int expected)
    {
        Assert.Equal(expected, (int)value);
    }
}
