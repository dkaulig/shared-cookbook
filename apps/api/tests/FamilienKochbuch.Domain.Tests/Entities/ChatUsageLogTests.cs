using FamilienKochbuch.Domain.Entities;
using Xunit;

namespace FamilienKochbuch.Domain.Tests.Entities;

/// <summary>
/// Invariants for the PF2 <see cref="ChatUsageLog"/> entity. Each row
/// is write-once: written by the synchronous chat-proxy endpoint after
/// Python responds, never updated.
/// </summary>
public class ChatUsageLogTests
{
    private static ChatUsageLog NewLog(
        Guid? userId = null,
        string sessionId = "sess-123",
        ChatUsageKind kind = ChatUsageKind.ChatTurn,
        int promptTokens = 120,
        int completionTokens = 40,
        int cachedPromptTokens = 0,
        string modelDeployment = "gpt-5.1-chat",
        DateTimeOffset? createdAt = null) =>
        new(
            userId: userId ?? Guid.NewGuid(),
            sessionId: sessionId,
            kind: kind,
            promptTokens: promptTokens,
            completionTokens: completionTokens,
            cachedPromptTokens: cachedPromptTokens,
            modelDeployment: modelDeployment,
            createdAt: createdAt ?? DateTimeOffset.UtcNow);

    [Fact]
    public void Constructor_Sets_All_Fields()
    {
        var userId = Guid.NewGuid();
        var createdAt = DateTimeOffset.UtcNow;
        var log = new ChatUsageLog(
            userId: userId,
            sessionId: "sess-abc",
            kind: ChatUsageKind.ChatToRecipe,
            promptTokens: 1500,
            completionTokens: 300,
            cachedPromptTokens: 200,
            modelDeployment: "gpt-5.1",
            createdAt: createdAt);

        Assert.NotEqual(Guid.Empty, log.Id);
        Assert.Equal(userId, log.UserId);
        Assert.Equal("sess-abc", log.SessionId);
        Assert.Equal(ChatUsageKind.ChatToRecipe, log.Kind);
        Assert.Equal(1500, log.PromptTokens);
        Assert.Equal(300, log.CompletionTokens);
        Assert.Equal(200, log.CachedPromptTokens);
        Assert.Equal("gpt-5.1", log.ModelDeployment);
        Assert.Equal(createdAt, log.CreatedAt);
    }

    [Fact]
    public void Constructor_Rejects_Empty_UserId()
    {
        Assert.Throws<ArgumentException>(() => NewLog(userId: Guid.Empty));
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void Constructor_Rejects_Blank_SessionId(string sid)
    {
        Assert.Throws<ArgumentException>(() => NewLog(sessionId: sid));
    }

    [Fact]
    public void Constructor_Rejects_Overlong_SessionId()
    {
        var longSid = new string('x', ChatUsageLog.SessionIdMaxLength + 1);
        Assert.Throws<ArgumentException>(() => NewLog(sessionId: longSid));
    }

    [Fact]
    public void Constructor_Trims_SessionId()
    {
        var log = NewLog(sessionId: "  sess-42  ");
        Assert.Equal("sess-42", log.SessionId);
    }

    [Theory]
    [InlineData(-1, 0, 0)]
    [InlineData(0, -1, 0)]
    [InlineData(0, 0, -1)]
    public void Constructor_Rejects_Negative_Counts(int prompt, int completion, int cached)
    {
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            NewLog(promptTokens: prompt, completionTokens: completion, cachedPromptTokens: cached));
    }

    [Fact]
    public void Constructor_Rejects_Cached_Greater_Than_Prompt()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            NewLog(promptTokens: 100, cachedPromptTokens: 200));
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void Constructor_Rejects_Blank_Model(string model)
    {
        Assert.Throws<ArgumentException>(() =>
            NewLog(modelDeployment: model));
    }

    [Fact]
    public void Constructor_Caps_Model_Length()
    {
        var long_ = new string('x', ChatUsageLog.ModelDeploymentMaxLength + 50);
        var log = NewLog(modelDeployment: long_);
        Assert.Equal(ChatUsageLog.ModelDeploymentMaxLength, log.ModelDeployment.Length);
    }

    [Fact]
    public void Constructor_Allows_Zero_Counts()
    {
        // Zero is legitimate — mock / null usage envelopes translate
        // to zero prompt + completion + cached. Only negatives reject.
        var log = NewLog(promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0);
        Assert.Equal(0, log.PromptTokens);
        Assert.Equal(0, log.CompletionTokens);
    }

    [Fact]
    public void Each_Instance_Gets_Unique_Id()
    {
        var a = NewLog();
        var b = NewLog();
        Assert.NotEqual(a.Id, b.Id);
    }
}
