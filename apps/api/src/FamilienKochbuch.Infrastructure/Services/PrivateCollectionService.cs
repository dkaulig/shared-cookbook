using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.Enums;
using FamilienKochbuch.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace FamilienKochbuch.Infrastructure.Services;

/// <inheritdoc />
public class PrivateCollectionService(AppDbContext db, TimeProvider clock) : IPrivateCollectionService
{
    public async Task EnsurePrivateCollectionAsync(Guid userId, CancellationToken ct = default)
    {
        if (userId == Guid.Empty)
            throw new ArgumentException("UserId must not be empty.", nameof(userId));

        // Idempotence check: if the user already has a Private Sammlung
        // membership, bail out. Matched via the IsPrivateCollection flag so
        // renaming/metadata changes elsewhere can never orphan this record.
        var alreadyHasOne = await db.GroupMemberships
            .Where(m => m.UserId == userId)
            .Join(db.Groups, m => m.GroupId, g => g.Id, (m, g) => g)
            .AnyAsync(g => g.IsPrivateCollection, ct);

        if (alreadyHasOne)
            return;

        var now = clock.GetUtcNow();
        var group = Group.CreatePrivateCollection(now);
        var membership = new GroupMembership(userId, group.Id, GroupRole.Admin, now);

        db.Groups.Add(group);
        db.GroupMemberships.Add(membership);
        await db.SaveChangesAsync(ct);
    }
}
