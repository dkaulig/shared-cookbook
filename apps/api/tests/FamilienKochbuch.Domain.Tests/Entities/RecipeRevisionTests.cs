using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.Enums;
using Xunit;

namespace FamilienKochbuch.Domain.Tests.Entities;

/// <summary>
/// Invariants for the S6 <see cref="RecipeRevision"/> entity. PRD §4.1 / §8.3
/// keeps only the last 5 entries per recipe; the entity itself is a
/// straight value object: required snapshot JSON, required FK fields, and
/// a non-default UTC timestamp. Pruning lives at the service layer.
/// </summary>
public class RecipeRevisionTests
{
    private static RecipeRevision NewRevision(
        Guid? recipeId = null,
        Guid? changedByUserId = null,
        RecipeChangeType changeType = RecipeChangeType.Created,
        string snapshotJson = "{\"title\":\"Spätzle\"}",
        string? diffSummary = null,
        DateTimeOffset? createdAt = null)
    {
        return new RecipeRevision(
            recipeId: recipeId ?? Guid.NewGuid(),
            changedByUserId: changedByUserId ?? Guid.NewGuid(),
            changeType: changeType,
            snapshotJson: snapshotJson,
            diffSummary: diffSummary,
            createdAt: createdAt ?? DateTimeOffset.UtcNow);
    }

    [Fact]
    public void Constructor_Sets_Fields_For_Minimal_Input()
    {
        var now = DateTimeOffset.UtcNow;
        var recipeId = Guid.NewGuid();
        var userId = Guid.NewGuid();

        var revision = new RecipeRevision(
            recipeId: recipeId,
            changedByUserId: userId,
            changeType: RecipeChangeType.Created,
            snapshotJson: "{\"title\":\"Pizza\"}",
            diffSummary: null,
            createdAt: now);

        Assert.NotEqual(Guid.Empty, revision.Id);
        Assert.Equal(recipeId, revision.RecipeId);
        Assert.Equal(userId, revision.ChangedByUserId);
        Assert.Equal(RecipeChangeType.Created, revision.ChangeType);
        Assert.Equal("{\"title\":\"Pizza\"}", revision.SnapshotJson);
        Assert.Null(revision.DiffSummary);
        Assert.Equal(now, revision.CreatedAt);
    }

    [Fact]
    public void Constructor_Accepts_DiffSummary_When_Provided()
    {
        var revision = NewRevision(
            changeType: RecipeChangeType.Edited,
            diffSummary: "Titel geändert, 2 Zutaten hinzugefügt");

        Assert.Equal("Titel geändert, 2 Zutaten hinzugefügt", revision.DiffSummary);
    }

    [Fact]
    public void Constructor_Trims_DiffSummary()
    {
        var revision = NewRevision(diffSummary: "  Rezept angelegt  ");

        Assert.Equal("Rezept angelegt", revision.DiffSummary);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void Constructor_Normalizes_Blank_DiffSummary_To_Null(string blank)
    {
        var revision = NewRevision(diffSummary: blank);

        Assert.Null(revision.DiffSummary);
    }

    [Fact]
    public void Constructor_Rejects_DiffSummary_Longer_Than_500_Chars()
    {
        var tooLong = new string('x', 501);

        Assert.Throws<ArgumentException>(() => NewRevision(diffSummary: tooLong));
    }

    [Fact]
    public void Constructor_Accepts_DiffSummary_At_500_Char_Boundary()
    {
        var boundary = new string('x', 500);

        var revision = NewRevision(diffSummary: boundary);

        Assert.Equal(boundary, revision.DiffSummary);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void Constructor_Rejects_Blank_SnapshotJson(string? blank)
    {
        Assert.Throws<ArgumentException>(() => NewRevision(snapshotJson: blank!));
    }

    [Fact]
    public void Constructor_Rejects_Empty_RecipeId()
    {
        Assert.Throws<ArgumentException>(() => NewRevision(recipeId: Guid.Empty));
    }

    [Fact]
    public void Constructor_Rejects_Empty_ChangedByUserId()
    {
        Assert.Throws<ArgumentException>(() => NewRevision(changedByUserId: Guid.Empty));
    }

    [Fact]
    public void Constructor_Rejects_Default_CreatedAt()
    {
        Assert.Throws<ArgumentException>(() => new RecipeRevision(
            recipeId: Guid.NewGuid(),
            changedByUserId: Guid.NewGuid(),
            changeType: RecipeChangeType.Created,
            snapshotJson: "{\"title\":\"x\"}",
            diffSummary: null,
            createdAt: default));
    }

    [Fact]
    public void Constructor_Accepts_All_Three_ChangeTypes()
    {
        var created = NewRevision(changeType: RecipeChangeType.Created);
        var edited = NewRevision(changeType: RecipeChangeType.Edited);
        var forked = NewRevision(changeType: RecipeChangeType.Forked);

        Assert.Equal(RecipeChangeType.Created, created.ChangeType);
        Assert.Equal(RecipeChangeType.Edited, edited.ChangeType);
        Assert.Equal(RecipeChangeType.Forked, forked.ChangeType);
    }
}
