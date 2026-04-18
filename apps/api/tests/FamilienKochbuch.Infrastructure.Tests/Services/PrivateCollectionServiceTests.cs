using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.Enums;
using FamilienKochbuch.Infrastructure.Persistence;
using FamilienKochbuch.Infrastructure.Services;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Time.Testing;
using Xunit;

namespace FamilienKochbuch.Infrastructure.Tests.Services;

/// <summary>
/// Exercises <see cref="PrivateCollectionService"/>. PRD §4.4 — every user
/// gets exactly one "Private Sammlung" auto-created; a second call for the
/// same user must be a no-op (idempotent).
/// </summary>
public class PrivateCollectionServiceTests : IAsyncLifetime
{
    private SqliteConnection _connection = null!;
    private AppDbContext _db = null!;
    private FakeTimeProvider _clock = null!;
    private PrivateCollectionService _service = null!;
    private User _user = null!;

    public async Task InitializeAsync()
    {
        _connection = new SqliteConnection("DataSource=:memory:");
        await _connection.OpenAsync();

        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseSqlite(_connection)
            .Options;
        _db = new AppDbContext(options);
        await _db.Database.EnsureCreatedAsync();

        _clock = new FakeTimeProvider(startDateTime: new DateTimeOffset(2026, 4, 17, 12, 0, 0, TimeSpan.Zero));
        _service = new PrivateCollectionService(_db, _clock);

        _user = new User { Role = UserRole.User };
        _user.SetDisplayName("Test User");
        _user.SetEmail("user@example.com");
        _db.Users.Add(_user);
        await _db.SaveChangesAsync();
    }

    public async Task DisposeAsync()
    {
        await _db.DisposeAsync();
        await _connection.DisposeAsync();
    }

    [Fact]
    public async Task EnsurePrivateCollectionAsync_Creates_Group_And_Admin_Membership()
    {
        await _service.EnsurePrivateCollectionAsync(_user.Id);

        var groups = await _db.Groups.ToListAsync();
        var group = Assert.Single(groups);
        Assert.Equal("Private Sammlung", group.Name);
        Assert.True(group.IsPrivateCollection);
        Assert.Equal(2m, group.DefaultServings);
        Assert.Equal(_clock.GetUtcNow(), group.CreatedAt);

        var memberships = await _db.GroupMemberships.ToListAsync();
        var membership = Assert.Single(memberships);
        Assert.Equal(_user.Id, membership.UserId);
        Assert.Equal(group.Id, membership.GroupId);
        Assert.Equal(GroupRole.Admin, membership.Role);
    }

    [Fact]
    public async Task EnsurePrivateCollectionAsync_Is_Idempotent_For_Same_User()
    {
        await _service.EnsurePrivateCollectionAsync(_user.Id);
        await _service.EnsurePrivateCollectionAsync(_user.Id);

        Assert.Equal(1, await _db.Groups.CountAsync(g => g.IsPrivateCollection));
        Assert.Equal(1, await _db.GroupMemberships.CountAsync(m => m.UserId == _user.Id));
    }

    [Fact]
    public async Task EnsurePrivateCollectionAsync_Creates_Distinct_Collections_For_Distinct_Users()
    {
        var userB = new User { Role = UserRole.User };
        userB.SetDisplayName("Second User");
        userB.SetEmail("user-b@example.com");
        _db.Users.Add(userB);
        await _db.SaveChangesAsync();

        await _service.EnsurePrivateCollectionAsync(_user.Id);
        await _service.EnsurePrivateCollectionAsync(userB.Id);

        Assert.Equal(2, await _db.Groups.CountAsync(g => g.IsPrivateCollection));
        Assert.Equal(2, await _db.GroupMemberships.CountAsync(m => m.Role == GroupRole.Admin));
    }

    [Fact]
    public async Task EnsurePrivateCollectionAsync_Rejects_Empty_User_Id()
    {
        await Assert.ThrowsAsync<ArgumentException>(() =>
            _service.EnsurePrivateCollectionAsync(Guid.Empty));
    }
}
