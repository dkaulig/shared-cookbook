using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.Enums;
using FamilienKochbuch.Infrastructure.Persistence;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace FamilienKochbuch.Infrastructure.Tests.Services;

/// <summary>
/// Persistence tests for the PF2 <see cref="ChatUsageLog"/> entity.
/// Verifies round-tripping, enum-as-int, and the two secondary indexes
/// the admin dashboard queries.
/// </summary>
public class ChatUsageLogPersistenceTests : IAsyncLifetime
{
    private SqliteConnection _connection = null!;
    private AppDbContext _db = null!;
    private Guid _userId;

    public async Task InitializeAsync()
    {
        _connection = new SqliteConnection("DataSource=:memory:");
        await _connection.OpenAsync();
        var options = new DbContextOptionsBuilder<AppDbContext>().UseSqlite(_connection).Options;
        _db = new AppDbContext(options);
        await _db.Database.EnsureCreatedAsync();

        var user = new User { Role = UserRole.User };
        user.SetDisplayName("Chatter");
        user.SetEmail("chatter@example.com");
        _db.Users.Add(user);
        await _db.SaveChangesAsync();
        _userId = user.Id;
    }

    public async Task DisposeAsync()
    {
        await _db.DisposeAsync();
        await _connection.DisposeAsync();
    }

    [Fact]
    public async Task ChatUsageLog_Round_Trips_Through_EF()
    {
        var createdAt = DateTimeOffset.UtcNow;
        var log = new ChatUsageLog(
            userId: _userId,
            sessionId: "sess-xyz",
            kind: ChatUsageKind.ChatToRecipe,
            promptTokens: 2000,
            completionTokens: 400,
            cachedPromptTokens: 500,
            modelDeployment: "gpt-5.1",
            createdAt: createdAt);
        _db.ChatUsageLogs.Add(log);
        await _db.SaveChangesAsync();

        using var fresh = new AppDbContext(
            new DbContextOptionsBuilder<AppDbContext>().UseSqlite(_connection).Options);
        var reloaded = await fresh.ChatUsageLogs.SingleAsync(c => c.Id == log.Id);

        Assert.Equal(_userId, reloaded.UserId);
        Assert.Equal("sess-xyz", reloaded.SessionId);
        Assert.Equal(ChatUsageKind.ChatToRecipe, reloaded.Kind);
        Assert.Equal(2000, reloaded.PromptTokens);
        Assert.Equal(400, reloaded.CompletionTokens);
        Assert.Equal(500, reloaded.CachedPromptTokens);
        Assert.Equal("gpt-5.1", reloaded.ModelDeployment);
    }

    [Fact]
    public async Task Query_By_User_Filters_Rows()
    {
        var other = new User { Role = UserRole.User };
        other.SetDisplayName("Other");
        other.SetEmail("other@example.com");
        _db.Users.Add(other);
        await _db.SaveChangesAsync();

        _db.ChatUsageLogs.Add(new ChatUsageLog(
            _userId, "s1", ChatUsageKind.ChatTurn, 10, 5, 0, "gpt-5.1-chat", DateTimeOffset.UtcNow));
        _db.ChatUsageLogs.Add(new ChatUsageLog(
            _userId, "s2", ChatUsageKind.ChatTurn, 20, 8, 0, "gpt-5.1-chat", DateTimeOffset.UtcNow));
        _db.ChatUsageLogs.Add(new ChatUsageLog(
            other.Id, "s3", ChatUsageKind.ChatTurn, 30, 10, 0, "gpt-5.1-chat", DateTimeOffset.UtcNow));
        await _db.SaveChangesAsync();

        var mine = await _db.ChatUsageLogs
            .Where(c => c.UserId == _userId)
            .ToListAsync();
        Assert.Equal(2, mine.Count);
        Assert.All(mine, log => Assert.Equal(_userId, log.UserId));
    }

    [Fact]
    public async Task Query_By_Model_Sums_Per_Deployment()
    {
        _db.ChatUsageLogs.Add(new ChatUsageLog(
            _userId, "s1", ChatUsageKind.ChatTurn, 100, 25, 0, "gpt-5.1-chat", DateTimeOffset.UtcNow));
        _db.ChatUsageLogs.Add(new ChatUsageLog(
            _userId, "s2", ChatUsageKind.ChatToRecipe, 400, 100, 0, "gpt-5.1-chat", DateTimeOffset.UtcNow));
        _db.ChatUsageLogs.Add(new ChatUsageLog(
            _userId, "s3", ChatUsageKind.ChatTurn, 50, 10, 0, "gpt-4.1-mini", DateTimeOffset.UtcNow));
        await _db.SaveChangesAsync();

        var perModel = await _db.ChatUsageLogs
            .GroupBy(c => c.ModelDeployment)
            .Select(g => new
            {
                Model = g.Key,
                Prompt = g.Sum(c => c.PromptTokens),
                Completion = g.Sum(c => c.CompletionTokens),
            })
            .ToListAsync();
        var chat = perModel.Single(p => p.Model == "gpt-5.1-chat");
        Assert.Equal(500, chat.Prompt);
        Assert.Equal(125, chat.Completion);
        var mini = perModel.Single(p => p.Model == "gpt-4.1-mini");
        Assert.Equal(50, mini.Prompt);
    }
}
