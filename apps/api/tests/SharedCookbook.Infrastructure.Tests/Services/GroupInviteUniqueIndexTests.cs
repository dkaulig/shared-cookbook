using SharedCookbook.Domain.Entities;
using SharedCookbook.Domain.Enums;
using SharedCookbook.Infrastructure.Persistence;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace SharedCookbook.Infrastructure.Tests.Services;

/// <summary>
/// Proves the filtered unique index on GroupInvites (one Pending per
/// (GroupId, InvitedUserId)) is materialized by the EF model. SQLite
/// supports partial indexes with the same filter syntax Postgres uses,
/// so the same EF fluent config produces a working constraint in both
/// environments.
/// </summary>
public class GroupInviteUniqueIndexTests : IAsyncLifetime
{
    private SqliteConnection _connection = null!;
    private AppDbContext _db = null!;
    private Guid _groupId;
    private Guid _inviterId;
    private Guid _inviteeId;

    public async Task InitializeAsync()
    {
        _connection = new SqliteConnection("DataSource=:memory:");
        await _connection.OpenAsync();

        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseSqlite(_connection)
            .Options;
        _db = new AppDbContext(options);
        await _db.Database.EnsureCreatedAsync();

        var inviter = new User { Role = UserRole.User };
        inviter.SetDisplayName("Inviter");
        inviter.SetEmail("inviter@example.com");
        var invitee = new User { Role = UserRole.User };
        invitee.SetDisplayName("Invitee");
        invitee.SetEmail("invitee@example.com");
        var group = new Group("Familie", null, DateTimeOffset.UtcNow);

        _db.Users.Add(inviter);
        _db.Users.Add(invitee);
        _db.Groups.Add(group);
        await _db.SaveChangesAsync();

        _groupId = group.Id;
        _inviterId = inviter.Id;
        _inviteeId = invitee.Id;
    }

    public async Task DisposeAsync()
    {
        await _db.DisposeAsync();
        await _connection.DisposeAsync();
    }

    [Fact]
    public async Task Second_Pending_Invite_For_Same_Group_And_User_Fails()
    {
        var first = new GroupInvite(_groupId, _inviterId, _inviteeId, DateTimeOffset.UtcNow);
        _db.GroupInvites.Add(first);
        await _db.SaveChangesAsync();

        var second = new GroupInvite(_groupId, _inviterId, _inviteeId, DateTimeOffset.UtcNow.AddMinutes(1));
        _db.GroupInvites.Add(second);

        await Assert.ThrowsAnyAsync<DbUpdateException>(() => _db.SaveChangesAsync());
    }

    [Fact]
    public async Task Accepted_Invite_Plus_New_Pending_Is_Allowed()
    {
        var accepted = new GroupInvite(_groupId, _inviterId, _inviteeId, DateTimeOffset.UtcNow);
        accepted.Accept(DateTimeOffset.UtcNow.AddMinutes(1));
        _db.GroupInvites.Add(accepted);
        await _db.SaveChangesAsync();

        // Filtered unique index applies only to Pending rows — an Accepted
        // invite must not block a later fresh Pending invite for the same pair.
        var pending = new GroupInvite(_groupId, _inviterId, _inviteeId, DateTimeOffset.UtcNow.AddMinutes(2));
        _db.GroupInvites.Add(pending);
        await _db.SaveChangesAsync();

        Assert.Equal(2, await _db.GroupInvites.CountAsync());
    }
}
