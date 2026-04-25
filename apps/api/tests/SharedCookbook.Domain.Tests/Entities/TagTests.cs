using SharedCookbook.Domain.Entities;
using SharedCookbook.Domain.Enums;
using Xunit;

namespace SharedCookbook.Domain.Tests.Entities;

/// <summary>
/// Invariants for <see cref="Tag"/>. Two factories:
///   - <see cref="Tag.CreateGlobal"/>: seeded, no user/group scoping.
///   - <see cref="Tag.CreateGroupScoped"/>: user-created, group-scoped, auto-category Custom.
/// Uniqueness on (Name, Category, GroupId) is infrastructure-level; the domain
/// ensures creators are well-formed.
/// </summary>
public class TagTests
{
    [Fact]
    public void CreateGlobal_Produces_Tag_With_Null_Owner()
    {
        var tag = Tag.CreateGlobal("vegetarisch", TagCategory.Diaet);

        Assert.NotEqual(Guid.Empty, tag.Id);
        Assert.Equal("vegetarisch", tag.Name);
        Assert.Equal(TagCategory.Diaet, tag.Category);
        Assert.Null(tag.CreatedByUserId);
        Assert.Null(tag.GroupId);
        Assert.True(tag.IsGlobal);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData(null)]
    public void CreateGlobal_Rejects_Blank_Name(string? invalid)
    {
        Assert.Throws<ArgumentException>(() => Tag.CreateGlobal(invalid!, TagCategory.Typ));
    }

    [Fact]
    public void CreateGlobal_Rejects_Name_Longer_Than_60_Chars()
    {
        var tooLong = new string('x', 61);

        Assert.Throws<ArgumentException>(() => Tag.CreateGlobal(tooLong, TagCategory.Typ));
    }

    [Fact]
    public void CreateGlobal_Trims_Name()
    {
        var tag = Tag.CreateGlobal("  vegan  ", TagCategory.Diaet);

        Assert.Equal("vegan", tag.Name);
    }

    [Fact]
    public void CreateGroupScoped_Produces_Custom_Tag_With_User_And_Group()
    {
        var userId = Guid.NewGuid();
        var groupId = Guid.NewGuid();

        var tag = Tag.CreateGroupScoped(userId, groupId, "Omas Rezepte");

        Assert.NotEqual(Guid.Empty, tag.Id);
        Assert.Equal("Omas Rezepte", tag.Name);
        Assert.Equal(TagCategory.Custom, tag.Category);
        Assert.Equal(userId, tag.CreatedByUserId);
        Assert.Equal(groupId, tag.GroupId);
        Assert.False(tag.IsGlobal);
    }

    [Fact]
    public void CreateGroupScoped_Rejects_Empty_User()
    {
        Assert.Throws<ArgumentException>(() =>
            Tag.CreateGroupScoped(Guid.Empty, Guid.NewGuid(), "Custom"));
    }

    [Fact]
    public void CreateGroupScoped_Rejects_Empty_Group()
    {
        Assert.Throws<ArgumentException>(() =>
            Tag.CreateGroupScoped(Guid.NewGuid(), Guid.Empty, "Custom"));
    }

    // GR1 — Grundrezept-Tags: the Komponente category exists alongside the
    // other predefined categories and is used by seeded sub-recipe tags
    // (Teig, Sauce, Dressing, …). It behaves like every other global
    // category — CreateGlobal accepts it verbatim, it is not Custom, and
    // it round-trips through the enum-to-int storage shape.

    [Fact]
    public void CreateGlobal_Accepts_Komponente_Category()
    {
        var tag = Tag.CreateGlobal("Pizzateig", TagCategory.Komponente);

        Assert.Equal(TagCategory.Komponente, tag.Category);
        Assert.True(tag.IsGlobal);
        Assert.NotEqual(TagCategory.Custom, tag.Category);
    }

    [Fact]
    public void Komponente_Is_Distinct_From_Every_Other_Category()
    {
        var others = new[]
        {
            TagCategory.Mahlzeit,
            TagCategory.Saison,
            TagCategory.Typ,
            TagCategory.Aufwand,
            TagCategory.Diaet,
            TagCategory.Kueche,
            TagCategory.Custom,
        };

        foreach (var other in others)
        {
            Assert.NotEqual(TagCategory.Komponente, other);
        }
    }
}
