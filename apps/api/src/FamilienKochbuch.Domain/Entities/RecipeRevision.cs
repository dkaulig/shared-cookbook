using FamilienKochbuch.Domain.Enums;

namespace FamilienKochbuch.Domain.Entities;

/// <summary>
/// A point-in-time snapshot of a recipe's content (PRD §4.1 / §8.3).
/// Phase 1 keeps only the last 5 per recipe — pruning is the service
/// layer's responsibility. The entity itself is a value object: once
/// recorded it never mutates.
/// </summary>
public class RecipeRevision
{
    public const int DiffSummaryMaxLength = 500;

    // EF-friendly parameterless ctor — private so domain construction goes
    // through the validating ctor below.
    private RecipeRevision() { }

    public RecipeRevision(
        Guid recipeId,
        Guid changedByUserId,
        RecipeChangeType changeType,
        string snapshotJson,
        string? diffSummary,
        DateTimeOffset createdAt)
    {
        if (recipeId == Guid.Empty)
            throw new ArgumentException("RecipeId must not be empty.", nameof(recipeId));
        if (changedByUserId == Guid.Empty)
            throw new ArgumentException("ChangedByUserId must not be empty.", nameof(changedByUserId));
        if (string.IsNullOrWhiteSpace(snapshotJson))
            throw new ArgumentException("SnapshotJson must not be blank.", nameof(snapshotJson));
        if (createdAt == default)
            throw new ArgumentException("CreatedAt must not be default.", nameof(createdAt));

        var normalizedDiff = ValidateDiffSummary(diffSummary);

        Id = Guid.NewGuid();
        RecipeId = recipeId;
        ChangedByUserId = changedByUserId;
        ChangeType = changeType;
        SnapshotJson = snapshotJson;
        DiffSummary = normalizedDiff;
        CreatedAt = createdAt;
    }

    public Guid Id { get; private set; }
    public Guid RecipeId { get; private set; }
    public Guid ChangedByUserId { get; private set; }
    public RecipeChangeType ChangeType { get; private set; }
    public string SnapshotJson { get; private set; } = string.Empty;
    public string? DiffSummary { get; private set; }
    public DateTimeOffset CreatedAt { get; private set; }

    private static string? ValidateDiffSummary(string? diffSummary)
    {
        if (string.IsNullOrWhiteSpace(diffSummary)) return null;
        var trimmed = diffSummary.Trim();
        if (trimmed.Length > DiffSummaryMaxLength)
            throw new ArgumentException(
                $"DiffSummary must be at most {DiffSummaryMaxLength} characters.", nameof(diffSummary));
        return trimmed;
    }
}
