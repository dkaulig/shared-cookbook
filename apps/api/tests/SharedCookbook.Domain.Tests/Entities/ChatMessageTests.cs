using SharedCookbook.Domain.Entities;
using Xunit;

namespace SharedCookbook.Domain.Tests.Entities;

/// <summary>
/// CR1 — invariants for <see cref="ChatMessage"/>. Messages are
/// immutable from a domain viewpoint once flushed; the
/// <c>internal</c> streaming-path helpers
/// (<see cref="ChatMessage.AppendContent"/> /
/// <see cref="ChatMessage.RecordUsage"/>) are exercised via the
/// <c>InternalsVisibleTo</c> wiring in the Domain csproj.
/// </summary>
public class ChatMessageTests
{
    [Fact]
    public void Create_Sets_Fields()
    {
        var sessionId = Guid.NewGuid();
        var now = DateTimeOffset.UtcNow;

        var msg = ChatMessage.Create(sessionId, ChatRole.User, "Hallo", now);

        Assert.NotEqual(Guid.Empty, msg.Id);
        Assert.Equal(sessionId, msg.SessionId);
        Assert.Equal(ChatRole.User, msg.Role);
        Assert.Equal("Hallo", msg.Content);
        Assert.Equal(now, msg.CreatedAt);
        Assert.Null(msg.PromptTokens);
        Assert.Null(msg.CompletionTokens);
        Assert.Null(msg.CachedPromptTokens);
    }

    [Fact]
    public void Create_Throws_On_Empty_SessionId()
    {
        Assert.Throws<ArgumentException>(() =>
            ChatMessage.Create(Guid.Empty, ChatRole.User, "x", DateTimeOffset.UtcNow));
    }

    [Fact]
    public void Create_Throws_On_Null_Content()
    {
        Assert.Throws<ArgumentNullException>(() =>
            ChatMessage.Create(Guid.NewGuid(), ChatRole.Assistant, null!, DateTimeOffset.UtcNow));
    }

    [Fact]
    public void Create_Throws_On_Content_Exceeds_Limit()
    {
        // Exactly 32 KiB + 1 byte — one over the hard ceiling.
        var tooLong = new string('x', ChatMessage.ContentMaxLength + 1);

        Assert.Throws<ArgumentException>(() =>
            ChatMessage.Create(Guid.NewGuid(), ChatRole.User, tooLong, DateTimeOffset.UtcNow));
    }

    [Fact]
    public void Create_Accepts_Content_At_Exact_Limit()
    {
        // Boundary check — exactly 32 KiB is allowed.
        var atLimit = new string('x', ChatMessage.ContentMaxLength);

        var msg = ChatMessage.Create(Guid.NewGuid(), ChatRole.Assistant, atLimit, DateTimeOffset.UtcNow);

        Assert.Equal(ChatMessage.ContentMaxLength, msg.Content.Length);
    }

    [Fact]
    public void Create_Accepts_Empty_Content()
    {
        // The SSE streaming path starts with an empty assistant row
        // and fills via AppendContent. Empty must not reject.
        var msg = ChatMessage.Create(Guid.NewGuid(), ChatRole.Assistant, string.Empty, DateTimeOffset.UtcNow);

        Assert.Equal(string.Empty, msg.Content);
    }

    [Fact]
    public void Create_Persists_Optional_Usage_Fields()
    {
        var msg = ChatMessage.Create(
            Guid.NewGuid(),
            ChatRole.Assistant,
            "Antwort",
            DateTimeOffset.UtcNow,
            promptTokens: 142,
            completionTokens: 87,
            cachedPromptTokens: 100);

        Assert.Equal(142, msg.PromptTokens);
        Assert.Equal(87, msg.CompletionTokens);
        Assert.Equal(100, msg.CachedPromptTokens);
    }

    [Fact]
    public void AppendContent_Grows_Content()
    {
        // AppendContent is internal → reachable via the Domain csproj's
        // InternalsVisibleTo for this test assembly.
        var msg = ChatMessage.Create(
            Guid.NewGuid(),
            ChatRole.Assistant,
            string.Empty,
            DateTimeOffset.UtcNow);

        msg.AppendContent("Klar");
        msg.AppendContent(", ");
        msg.AppendContent("gerne!");

        Assert.Equal("Klar, gerne!", msg.Content);
    }

    [Fact]
    public void RecordUsage_Sets_Usage_Fields()
    {
        var msg = ChatMessage.Create(
            Guid.NewGuid(),
            ChatRole.Assistant,
            "Antwort",
            DateTimeOffset.UtcNow);

        msg.RecordUsage(prompt: 50, completion: 30, cached: 10);

        Assert.Equal(50, msg.PromptTokens);
        Assert.Equal(30, msg.CompletionTokens);
        Assert.Equal(10, msg.CachedPromptTokens);
    }

    [Fact]
    public void RecordUsage_Accepts_Nulls()
    {
        var msg = ChatMessage.Create(
            Guid.NewGuid(),
            ChatRole.Assistant,
            "Antwort",
            DateTimeOffset.UtcNow,
            promptTokens: 100,
            completionTokens: 50,
            cachedPromptTokens: 20);

        // Azure sometimes withholds the usage envelope — null-out path
        // must be expressible.
        msg.RecordUsage(null, null, null);

        Assert.Null(msg.PromptTokens);
        Assert.Null(msg.CompletionTokens);
        Assert.Null(msg.CachedPromptTokens);
    }
}
