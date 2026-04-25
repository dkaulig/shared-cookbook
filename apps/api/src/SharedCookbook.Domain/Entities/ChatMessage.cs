namespace SharedCookbook.Domain.Entities;

/// <summary>
/// CR1 — one turn in a <see cref="ChatSession"/>. Rows are created
/// strictly in creation order: a user message first, followed by the
/// assistant's streamed reply (which may grow via
/// <see cref="AppendContent"/> while the SSE stream is open).
///
/// The aggregate is owned by a single <see cref="ChatSession"/> via
/// the <see cref="SessionId"/> FK (cascade-delete configured in the EF
/// mapping). Neither users nor assistants edit history — once a turn
/// is flushed it is immutable from the domain's viewpoint; the only
/// in-memory mutations are the streaming-path helpers
/// <see cref="AppendContent"/> and <see cref="RecordUsage"/>, both
/// marked <c>internal</c> so callers outside this project (and the
/// test assembly, via <c>InternalsVisibleTo</c>) can't repurpose
/// them post-save.
/// </summary>
public sealed class ChatMessage
{
    /// <summary>32 KiB ceiling on message content. Covers long
    /// assistant answers and pasted-recipe user prompts while keeping
    /// a single row boundable for index/byte budgets.</summary>
    public const int ContentMaxLength = 32 * 1024;

    public Guid Id { get; private set; }
    public Guid SessionId { get; private set; }
    public ChatRole Role { get; private set; }
    public string Content { get; private set; } = string.Empty;
    public DateTimeOffset CreatedAt { get; private set; }

    /// <summary>Prompt-side token count on assistant messages only
    /// (user/system messages leave this <c>null</c>).</summary>
    public int? PromptTokens { get; private set; }

    /// <summary>Completion-side token count on assistant messages
    /// only.</summary>
    public int? CompletionTokens { get; private set; }

    /// <summary>Cached-prompt subset of <see cref="PromptTokens"/>,
    /// reported by Azure when prompt-caching hits.</summary>
    public int? CachedPromptTokens { get; private set; }

    // EF-friendly parameterless ctor — domain construction goes through
    // the validating factory below.
    private ChatMessage() { }

    /// <summary>
    /// Creates a new message bound to <paramref name="sessionId"/>.
    /// Content may be empty (the SSE streaming path starts with an
    /// empty assistant row and fills it via <see cref="AppendContent"/>
    /// as tokens arrive); null is rejected.
    /// </summary>
    public static ChatMessage Create(
        Guid sessionId,
        ChatRole role,
        string content,
        DateTimeOffset now,
        int? promptTokens = null,
        int? completionTokens = null,
        int? cachedPromptTokens = null)
    {
        if (sessionId == Guid.Empty)
            throw new ArgumentException("sessionId required", nameof(sessionId));
        if (content is null)
            throw new ArgumentNullException(nameof(content));
        if (content.Length > ContentMaxLength)
            throw new ArgumentException($"content exceeds {ContentMaxLength}", nameof(content));

        return new ChatMessage
        {
            Id = Guid.NewGuid(),
            SessionId = sessionId,
            Role = role,
            Content = content,
            CreatedAt = now,
            PromptTokens = promptTokens,
            CompletionTokens = completionTokens,
            CachedPromptTokens = cachedPromptTokens,
        };
    }

    /// <summary>
    /// SSE streaming path: the .NET endpoint accumulates tokens while
    /// the stream is open. If the client disconnects mid-stream we
    /// persist whatever has been streamed so far — allow appending
    /// to the content while the message row is still in-memory.
    /// </summary>
    internal void AppendContent(string delta) => Content += delta;

    /// <summary>
    /// Stamps usage totals after the Azure <c>usage</c> event arrives.
    /// Called once per assistant message, at most, by the turn handler.
    /// </summary>
    internal void RecordUsage(int? prompt, int? completion, int? cached)
    {
        PromptTokens = prompt;
        CompletionTokens = completion;
        CachedPromptTokens = cached;
    }
}
