namespace FamilienKochbuch.Infrastructure.Ai;

/// <summary>
/// CR2 — seam between the chat/turn endpoint + title service and the
/// native-.NET Azure OpenAI streaming client. The interface is tiny on
/// purpose: tests substitute a fake that yields a deterministic
/// <see cref="IAsyncEnumerable{ChatStreamChunk}"/>; production wires
/// <see cref="AzureOpenAIChatClient"/>.
///
/// Streaming shape — callers expect the chunk sequence
/// <c>Token* Usage? Error?</c>. Usage fires at most once per stream and
/// always before the enumerable completes; Error terminates the stream.
///
/// Lives in the Infrastructure assembly because the production impl is
/// a straight <see cref="System.Net.Http.HttpClient"/> caller and
/// Infrastructure cannot take a reference on the Api assembly.
/// </summary>
public interface IAzureOpenAIChatClient
{
    /// <summary>
    /// Streaming chat-completion. Yields <see cref="ChatStreamChunk.Token"/>
    /// deltas as Azure emits them, optionally a single
    /// <see cref="ChatStreamChunk.Usage"/> right before end-of-stream,
    /// and a single <see cref="ChatStreamChunk.Error"/> on any transport
    /// or parse failure (the enumerable completes cleanly after an
    /// error — callers persist whatever streamed so far).
    /// </summary>
    IAsyncEnumerable<ChatStreamChunk> StreamAsync(
        IReadOnlyList<ChatCompletionMessage> messages,
        CancellationToken ct);

    /// <summary>
    /// One-shot non-streaming completion, used by the auto-title service.
    /// Returns the assistant's reply string; throws on transport /
    /// parse error so the fire-and-forget caller can log + drop.
    /// </summary>
    Task<string> CompleteAsync(
        IReadOnlyList<ChatCompletionMessage> messages,
        CancellationToken ct);
}

/// <summary>One message in the chat-completions request array. Mirrors
/// the Azure payload shape (role + content strings only — no tool calls,
/// no images — scope-guarded for CR2).</summary>
public sealed record ChatCompletionMessage(string Role, string Content);

/// <summary>
/// Discriminated-union-ish event emitted by
/// <see cref="IAzureOpenAIChatClient.StreamAsync"/>. Concrete records
/// live as nested types so exhaustive pattern-matches catch new shapes
/// at compile time.
/// </summary>
public abstract record ChatStreamChunk
{
    /// <summary>One delta from Azure's <c>choices[0].delta.content</c>.
    /// May be an empty string (Azure sometimes emits role-only chunks
    /// at the start) — callers should append unconditionally.</summary>
    public sealed record Token(string Text) : ChatStreamChunk;

    /// <summary>Azure's <c>usage</c> envelope, one per stream.
    /// <c>Cached</c> is the <c>prompt_tokens_details.cached_tokens</c>
    /// subfield (0 when absent).</summary>
    public sealed record Usage(int Prompt, int Completion, int Cached) : ChatStreamChunk;

    /// <summary>Transport / parse error. Terminates the stream. Code is
    /// a short machine-readable string (e.g. <c>azure_unavailable</c>);
    /// Message is a short human-readable German string — the endpoint
    /// forwards this into the SSE <c>error</c> event verbatim.</summary>
    public sealed record Error(string Code, string Message) : ChatStreamChunk;
}
