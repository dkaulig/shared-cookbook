namespace SharedCookbook.Infrastructure.Services;

/// <summary>
/// Ensures every user has the mandatory per-user "Private Sammlung"
/// (<see cref="SharedCookbook.Domain.Entities.Group"/> with
/// IsPrivateCollection=true + the user as Admin). Called on signup and
/// from the seed-admin path; idempotent so it can also run on login for
/// backfill if needed.
/// </summary>
public interface IPrivateCollectionService
{
    Task EnsurePrivateCollectionAsync(Guid userId, CancellationToken ct = default);
}
