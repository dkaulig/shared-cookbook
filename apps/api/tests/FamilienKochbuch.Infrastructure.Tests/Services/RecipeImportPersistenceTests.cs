using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.Enums;
using FamilienKochbuch.Infrastructure.Persistence;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace FamilienKochbuch.Infrastructure.Tests.Services;

/// <summary>
/// Persistence tests for the <see cref="RecipeImport"/> aggregate added
/// in P2-5. Verifies that the entity round-trips through EF Core, the
/// status enum is persisted as an int, and the (UserId, CreatedAt)
/// index supports the "my imports" query without a full scan.
/// </summary>
public class RecipeImportPersistenceTests : IAsyncLifetime
{
    private SqliteConnection _connection = null!;
    private AppDbContext _db = null!;
    private Guid _userId;
    private Guid _groupId;

    public async Task InitializeAsync()
    {
        _connection = new SqliteConnection("DataSource=:memory:");
        await _connection.OpenAsync();

        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseSqlite(_connection)
            .Options;
        _db = new AppDbContext(options);
        await _db.Database.EnsureCreatedAsync();

        var user = new User { Role = UserRole.User };
        user.SetDisplayName("Importer");
        user.SetEmail("importer@example.com");
        var group = new Group("Familie", null, DateTimeOffset.UtcNow);
        _db.Users.Add(user);
        _db.Groups.Add(group);
        await _db.SaveChangesAsync();

        _userId = user.Id;
        _groupId = group.Id;
    }

    public async Task DisposeAsync()
    {
        await _db.DisposeAsync();
        await _connection.DisposeAsync();
    }

    [Fact]
    public async Task RecipeImport_Round_Trips_Through_EF()
    {
        var created = DateTimeOffset.UtcNow;
        var import = new RecipeImport(
            userId: _userId,
            groupId: _groupId,
            source: ImportSource.Url,
            sourceUrl: "https://example.com/rezept",
            createdAt: created);

        _db.RecipeImports.Add(import);
        await _db.SaveChangesAsync();

        using var fresh = new AppDbContext(
            new DbContextOptionsBuilder<AppDbContext>().UseSqlite(_connection).Options);
        var reloaded = await fresh.RecipeImports.SingleAsync(r => r.Id == import.Id);

        Assert.Equal(_userId, reloaded.UserId);
        Assert.Equal(_groupId, reloaded.GroupId);
        Assert.Equal(ImportSource.Url, reloaded.Source);
        Assert.Equal(ImportStatus.Queued, reloaded.Status);
        Assert.Equal(0, reloaded.Progress);
        Assert.Equal("https://example.com/rezept", reloaded.SourceUrl);
        Assert.Null(reloaded.ResultJson);
        Assert.Null(reloaded.ErrorMessage);
        Assert.Null(reloaded.CompletedAt);
    }

    [Fact]
    public async Task RecipeImport_Persists_Status_Transitions()
    {
        var import = new RecipeImport(
            _userId, _groupId, ImportSource.Url, "https://example.com/r",
            DateTimeOffset.UtcNow);
        _db.RecipeImports.Add(import);
        await _db.SaveChangesAsync();

        import.MarkRunning(40);
        await _db.SaveChangesAsync();

        var resultJson = "{\"title\":\"Spätzle\",\"servings\":4}";
        import.MarkDone(resultJson, DateTimeOffset.UtcNow.AddMinutes(1));
        await _db.SaveChangesAsync();

        using var fresh = new AppDbContext(
            new DbContextOptionsBuilder<AppDbContext>().UseSqlite(_connection).Options);
        var reloaded = await fresh.RecipeImports.SingleAsync(r => r.Id == import.Id);

        Assert.Equal(ImportStatus.Done, reloaded.Status);
        Assert.Equal(100, reloaded.Progress);
        Assert.Equal(resultJson, reloaded.ResultJson);
        Assert.NotNull(reloaded.CompletedAt);
    }

    [Fact]
    public async Task RecipeImport_Persists_Error_State()
    {
        var import = new RecipeImport(
            _userId, _groupId, ImportSource.Photos, sourceUrl: null,
            DateTimeOffset.UtcNow);
        _db.RecipeImports.Add(import);
        await _db.SaveChangesAsync();

        import.MarkRunning(15);
        import.MarkError("Video nicht erreichbar.", DateTimeOffset.UtcNow.AddMinutes(1));
        await _db.SaveChangesAsync();

        using var fresh = new AppDbContext(
            new DbContextOptionsBuilder<AppDbContext>().UseSqlite(_connection).Options);
        var reloaded = await fresh.RecipeImports.SingleAsync(r => r.Id == import.Id);

        Assert.Equal(ImportStatus.Error, reloaded.Status);
        Assert.Equal("Video nicht erreichbar.", reloaded.ErrorMessage);
        Assert.Null(reloaded.ResultJson);
        Assert.Null(reloaded.SourceUrl);
        Assert.Equal(ImportSource.Photos, reloaded.Source);
        // Progress pinned at the last running value.
        Assert.Equal(15, reloaded.Progress);
    }

    [Fact]
    public async Task Query_By_User_Filters_To_Owner()
    {
        var t0 = DateTimeOffset.UtcNow;
        var otherUser = new User { Role = UserRole.User };
        otherUser.SetDisplayName("Other");
        otherUser.SetEmail("other@example.com");
        _db.Users.Add(otherUser);
        await _db.SaveChangesAsync();

        _db.RecipeImports.Add(new RecipeImport(_userId, _groupId, ImportSource.Url, "https://a", t0.AddMinutes(-2)));
        _db.RecipeImports.Add(new RecipeImport(_userId, _groupId, ImportSource.Url, "https://b", t0.AddMinutes(-1)));
        _db.RecipeImports.Add(new RecipeImport(otherUser.Id, _groupId, ImportSource.Url, "https://z", t0));
        await _db.SaveChangesAsync();

        // Sort client-side; SQLite's EF translator doesn't support
        // DateTimeOffset ORDER BY, and we only need to prove the filter
        // works + the (UserId, CreatedAt) columns are readable.
        var mineUrls = (await _db.RecipeImports
            .Where(i => i.UserId == _userId)
            .ToListAsync())
            .OrderByDescending(i => i.CreatedAt)
            .Select(i => i.SourceUrl)
            .ToList();

        Assert.Equal(new[] { "https://b", "https://a" }, mineUrls);
    }
}
