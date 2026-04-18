using FamilienKochbuch.Domain.Enums;
using Xunit;

namespace FamilienKochbuch.Domain.Tests.Entities;

/// <summary>
/// Stable wire values for the S6 <see cref="RecipeChangeType"/> enum. Both
/// the API JSON contract and the EF column store the integer underlying
/// value, so reordering would silently corrupt history. These tests pin
/// the assignments.
/// </summary>
public class RecipeChangeTypeTests
{
    [Fact]
    public void Enum_Has_Three_Stable_Members()
    {
        var members = Enum.GetValues<RecipeChangeType>();

        Assert.Equal(3, members.Length);
        Assert.Contains(RecipeChangeType.Created, members);
        Assert.Contains(RecipeChangeType.Edited, members);
        Assert.Contains(RecipeChangeType.Forked, members);
    }

    [Theory]
    [InlineData(RecipeChangeType.Created, 0)]
    [InlineData(RecipeChangeType.Edited, 1)]
    [InlineData(RecipeChangeType.Forked, 2)]
    public void Enum_Values_Are_Stable(RecipeChangeType value, int expected)
    {
        Assert.Equal(expected, (int)value);
    }
}
