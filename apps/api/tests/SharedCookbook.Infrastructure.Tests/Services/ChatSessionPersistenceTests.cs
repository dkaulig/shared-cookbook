using SharedCookbook.Domain.Entities;
using SharedCookbook.Infrastructure.Persistence;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace SharedCookbook.Infrastructure.Tests.Services;

/// <summary>
/// CR1 — persistence smoke for <see cref="ChatSession"/> +
/// <see cref="ChatMessage"/>. Verifies the EF round-trip, the enum-
/// as-int mapping on <see cref="ChatMessage.Role"/>, and the cascade-
/// delete from session → messages. Uses the same SQLite in-memory
/// pattern as the <c>ShoppingList</c> / <c>ChatUsageLog</c> tests.
/// </summary>
public class ChatSessionPersistenceTests : IAsyncLifetime
{
    private SqliteConnection _connection = null!;
    private AppDbContext _db = null!;

    public async Task InitializeAsync()
    {
        _connection = new SqliteConnection("DataSource=:memory:");
        await _connection.OpenAsync();
        var options = new DbContextOptionsBuilder<AppDbContext>().UseSqlite(_connection).Options;
        _db = new AppDbContext(options);
        await _db.Database.EnsureCreatedAsync();
    }

    public async Task DisposeAsync()
    {
        await _db.DisposeAsync();
        await _connection.DisposeAsync();
    }

    [Fact]
    public async Task ChatSession_And_ChatMessage_Round_Trip_Through_EF()
    {
        var now = DateTimeOffset.UtcNow;
        var userId = Guid.NewGuid();
        var session = ChatSession.Create(userId, now);

        var userMsg = ChatMessage.Create(
            session.Id, ChatRole.User, "Zeig mir ein Nudelrezept", now);
        var assistantMsg = ChatMessage.Create(
            session.Id,
            ChatRole.Assistant,
            "Klar, wie wäre es mit Spaghetti aglio e olio?",
            now.AddSeconds(3),
            promptTokens: 142,
            completionTokens: 87,
            cachedPromptTokens: 100);

        session.RecordMessageAdded(now);
        session.RecordMessageAdded(now.AddSeconds(3));
        session.Rename("Nudelrezept", now.AddSeconds(3));

        _db.ChatSessions.Add(session);
        _db.ChatMessages.Add(userMsg);
        _db.ChatMessages.Add(assistantMsg);
        await _db.SaveChangesAsync();

        // Fresh context so we reload through the DB, not the tracker.
        using var fresh = new AppDbContext(
            new DbContextOptionsBuilder<AppDbContext>().UseSqlite(_connection).Options);

        var reloadedSession = await fresh.ChatSessions.SingleAsync(s => s.Id == session.Id);
        Assert.Equal(userId, reloadedSession.UserId);
        Assert.Equal("Nudelrezept", reloadedSession.Title);
        Assert.Equal(2, reloadedSession.MessageCount);

        // SQLite can't ORDER BY DateTimeOffset server-side; sort in
        // memory. Postgres (the prod provider) handles this natively.
        var reloadedMessages = (await fresh.ChatMessages
                .Where(m => m.SessionId == session.Id)
                .ToListAsync())
            .OrderBy(m => m.CreatedAt)
            .ToList();

        Assert.Equal(2, reloadedMessages.Count);
        Assert.Equal(ChatRole.User, reloadedMessages[0].Role);
        Assert.Equal("Zeig mir ein Nudelrezept", reloadedMessages[0].Content);
        Assert.Null(reloadedMessages[0].PromptTokens);

        Assert.Equal(ChatRole.Assistant, reloadedMessages[1].Role);
        Assert.Equal("Klar, wie wäre es mit Spaghetti aglio e olio?", reloadedMessages[1].Content);
        Assert.Equal(142, reloadedMessages[1].PromptTokens);
        Assert.Equal(87, reloadedMessages[1].CompletionTokens);
        Assert.Equal(100, reloadedMessages[1].CachedPromptTokens);
    }

    [Fact]
    public async Task Deleting_Session_Cascades_To_Messages()
    {
        var now = DateTimeOffset.UtcNow;
        var session = ChatSession.Create(Guid.NewGuid(), now);
        var msg = ChatMessage.Create(session.Id, ChatRole.User, "hi", now);
        _db.ChatSessions.Add(session);
        _db.ChatMessages.Add(msg);
        await _db.SaveChangesAsync();

        _db.ChatSessions.Remove(session);
        await _db.SaveChangesAsync();

        using var fresh = new AppDbContext(
            new DbContextOptionsBuilder<AppDbContext>().UseSqlite(_connection).Options);
        Assert.False(await fresh.ChatSessions.AnyAsync(s => s.Id == session.Id));
        Assert.False(await fresh.ChatMessages.AnyAsync(m => m.Id == msg.Id));
    }
}
