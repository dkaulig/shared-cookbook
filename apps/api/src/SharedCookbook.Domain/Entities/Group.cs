using SharedCookbook.Domain.Common;

namespace SharedCookbook.Domain.Entities;

/// <summary>
/// A collaborative recipe collection. Members join via <see cref="GroupMembership"/>.
/// Every user owns exactly one reserved <c>Private Sammlung</c> group
/// (<see cref="IsPrivateCollection"/> = true) which must never be deletable
/// (PRD §4.4 — "Private Sammlung: implizite Ein-Personen-Gruppe, automatisch
/// für jeden User angelegt").
///
/// OFF3: implements <see cref="IVersionedEntity"/> so every metadata edit
/// (name, description, default-servings, cover) bumps a monotonically
/// increasing <see cref="Version"/> used for ETag + optimistic
/// concurrency on mutation endpoints.
/// </summary>
public class Group : IVersionedEntity
{
    public const int NameMaxLength = 100;
    public const int DescriptionMaxLength = 500;
    public const string PrivateCollectionName = "Private Sammlung";
    /// <summary>
    /// Upper bound for <see cref="DefaultServings"/>. Aligned with the web
    /// editor's 0.5..20 range (PRD §4.5 / S5). 20 portions is already far
    /// beyond what any sane family dinner needs, so anything above is
    /// rejected as input error.
    /// </summary>
    public const decimal MaxDefaultServings = 20m;

    // EF-friendly parameterless ctor — private so all domain construction
    // goes through the validating ctor below.
    private Group() { }

    public Group(
        string name,
        string? description,
        DateTimeOffset createdAt,
        decimal defaultServings = 2m)
    {
        if (string.IsNullOrWhiteSpace(name))
            throw new ArgumentException("Group name must not be blank.", nameof(name));

        var trimmedName = name.Trim();
        if (trimmedName.Length > NameMaxLength)
            throw new ArgumentException(
                $"Group name must be at most {NameMaxLength} characters.", nameof(name));

        var normalizedDescription = string.IsNullOrWhiteSpace(description) ? null : description.Trim();
        if (normalizedDescription is not null && normalizedDescription.Length > DescriptionMaxLength)
            throw new ArgumentException(
                $"Group description must be at most {DescriptionMaxLength} characters.", nameof(description));

        if (defaultServings <= 0m)
            throw new ArgumentException(
                "Default servings must be greater than zero.", nameof(defaultServings));
        if (defaultServings > MaxDefaultServings)
            throw new ArgumentException(
                $"Default servings must be at most {MaxDefaultServings}.", nameof(defaultServings));

        Id = Guid.NewGuid();
        Name = trimmedName;
        Description = normalizedDescription;
        DefaultServings = defaultServings;
        Version = 0;
        CreatedAt = createdAt;
        IsPrivateCollection = false;
    }

    /// <summary>Factory for the auto-created Private Sammlung per user.</summary>
    public static Group CreatePrivateCollection(DateTimeOffset createdAt)
    {
        var group = new Group(PrivateCollectionName, description: null, createdAt: createdAt);
        group.IsPrivateCollection = true;
        return group;
    }

    public Guid Id { get; private set; }

    public string Name { get; private set; } = string.Empty;

    public string? Description { get; private set; }

    public string? CoverImageUrl { get; private set; }

    public decimal DefaultServings { get; private set; } = 2m;

    /// <summary>True iff this is the auto-created per-user Private Sammlung.
    /// Private collections are never soft-deletable.</summary>
    public bool IsPrivateCollection { get; private set; }

    public DateTimeOffset CreatedAt { get; private set; }

    public DateTimeOffset? DeletedAt { get; private set; }

    /// <summary>
    /// OFF3 optimistic-concurrency token — monotonically increases by
    /// one on every metadata edit or soft-delete. Starts at 0.
    /// </summary>
    public int Version { get; private set; }

    /// <summary>
    /// <see cref="IVersionedEntity.BumpVersion"/>. Every public mutation
    /// on the aggregate invokes this exactly once per call.
    /// </summary>
    public void BumpVersion() => Version++;

    /// <summary>Soft-deletes the group. Throws when the group is the per-user
    /// Private Sammlung — that record is reserved and always present.</summary>
    public void SoftDelete(DateTimeOffset at)
    {
        if (IsPrivateCollection)
            throw new InvalidOperationException(
                "Private Sammlung cannot be deleted.");

        DeletedAt = at;
        BumpVersion();
    }

    /// <summary>Partial metadata update. Any null argument leaves the
    /// corresponding field untouched; <c>defaultServings</c> null means no
    /// change. All present fields are validated the same way as the
    /// constructor. Bumps <see cref="Version"/> exactly once per call
    /// regardless of how many fields changed (mirrors the
    /// <see cref="IVersionedEntity"/> contract — one mutation method
    /// call = one version bump).</summary>
    public void UpdateMetadata(
        string? name,
        string? description,
        decimal? defaultServings,
        string? coverImageUrl)
    {
        if (name is not null)
        {
            if (string.IsNullOrWhiteSpace(name))
                throw new ArgumentException("Group name must not be blank.", nameof(name));
            var trimmed = name.Trim();
            if (trimmed.Length > NameMaxLength)
                throw new ArgumentException(
                    $"Group name must be at most {NameMaxLength} characters.", nameof(name));
            Name = trimmed;
        }

        if (description is not null)
        {
            var trimmed = description.Trim();
            if (trimmed.Length == 0)
            {
                Description = null;
            }
            else
            {
                if (trimmed.Length > DescriptionMaxLength)
                    throw new ArgumentException(
                        $"Group description must be at most {DescriptionMaxLength} characters.", nameof(description));
                Description = trimmed;
            }
        }

        if (defaultServings.HasValue)
        {
            if (defaultServings.Value <= 0m)
                throw new ArgumentException(
                    "Default servings must be greater than zero.", nameof(defaultServings));
            if (defaultServings.Value > MaxDefaultServings)
                throw new ArgumentException(
                    $"Default servings must be at most {MaxDefaultServings}.", nameof(defaultServings));
            DefaultServings = defaultServings.Value;
        }

        if (coverImageUrl is not null)
        {
            var trimmed = coverImageUrl.Trim();
            CoverImageUrl = trimmed.Length == 0 ? null : trimmed;
        }

        BumpVersion();
    }
}
