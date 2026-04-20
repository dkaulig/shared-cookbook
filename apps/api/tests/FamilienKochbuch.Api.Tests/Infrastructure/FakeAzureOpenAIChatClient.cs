using System.Runtime.CompilerServices;
using FamilienKochbuch.Infrastructure.Ai;

namespace FamilienKochbuch.Api.Tests.Infrastructure;

/// <summary>
/// CR2 — deterministic <see cref="IAzureOpenAIChatClient"/> double used
/// by the chat-turn SSE tests. Per-test code scripts a sequence of
/// chunks to yield; the production client is swapped out via
/// <c>ConfigureTestServices</c>.
///
/// The fake is stateless across streams — each call to
/// <see cref="StreamAsync"/> replays the scripted chunk list verbatim.
/// The one-shot <see cref="CompleteAsync"/> returns whatever the test
/// set via <see cref="SetTitle"/> (default "Generierter Titel") and
/// records every call into <see cref="CompleteCalls"/>.
/// </summary>
public sealed class FakeAzureOpenAIChatClient : IAzureOpenAIChatClient
{
    private List<ChatStreamChunk> _scripted = new();
    private string _titleResult = "Generierter Titel";
    private bool _titleThrows;
    private TimeSpan _delayBetweenChunks = TimeSpan.Zero;

    /// <summary>Every <see cref="StreamAsync"/> invocation is appended
    /// here so tests can assert the exact message sequence sent to
    /// Azure.</summary>
    public List<IReadOnlyList<ChatCompletionMessage>> StreamCalls { get; } = new();

    /// <summary>Same for <see cref="CompleteAsync"/> — used by the
    /// title-generation tests.</summary>
    public List<IReadOnlyList<ChatCompletionMessage>> CompleteCalls { get; } = new();

    /// <summary>Drop the current script and start recording a new one.
    /// Returns this so the call sites stay short.</summary>
    public FakeAzureOpenAIChatClient Reset()
    {
        _scripted = new List<ChatStreamChunk>();
        _titleResult = "Generierter Titel";
        _titleThrows = false;
        _delayBetweenChunks = TimeSpan.Zero;
        StreamCalls.Clear();
        CompleteCalls.Clear();
        return this;
    }

    /// <summary>Emit a sequence of token strings, in order.</summary>
    public FakeAzureOpenAIChatClient QueueTokens(params string[] tokens)
    {
        foreach (var t in tokens)
            _scripted.Add(new ChatStreamChunk.Token(t));
        return this;
    }

    /// <summary>Append a usage envelope. Fires after all queued
    /// tokens — same semantics as Azure.</summary>
    public FakeAzureOpenAIChatClient QueueUsage(int prompt, int completion, int cached)
    {
        _scripted.Add(new ChatStreamChunk.Usage(prompt, completion, cached));
        return this;
    }

    /// <summary>Append an error chunk. Terminates the stream.</summary>
    public FakeAzureOpenAIChatClient QueueError(string code, string message)
    {
        _scripted.Add(new ChatStreamChunk.Error(code, message));
        return this;
    }

    /// <summary>Slow the fake stream down so tests can cancel mid-stream
    /// deterministically.</summary>
    public FakeAzureOpenAIChatClient DelayBetweenChunks(TimeSpan delay)
    {
        _delayBetweenChunks = delay;
        return this;
    }

    /// <summary>Set the string returned by the next
    /// <see cref="CompleteAsync"/> call.</summary>
    public FakeAzureOpenAIChatClient SetTitle(string title)
    {
        _titleResult = title;
        return this;
    }

    /// <summary>Make <see cref="CompleteAsync"/> throw — lets a test
    /// exercise the title-service's error-swallow path.</summary>
    public FakeAzureOpenAIChatClient MakeTitleFail()
    {
        _titleThrows = true;
        return this;
    }

    public async IAsyncEnumerable<ChatStreamChunk> StreamAsync(
        IReadOnlyList<ChatCompletionMessage> messages,
        [EnumeratorCancellation] CancellationToken ct)
    {
        StreamCalls.Add(messages.ToArray());
        foreach (var chunk in _scripted)
        {
            ct.ThrowIfCancellationRequested();
            if (_delayBetweenChunks > TimeSpan.Zero)
                await Task.Delay(_delayBetweenChunks, ct).ConfigureAwait(false);
            yield return chunk;
        }
    }

    public Task<string> CompleteAsync(
        IReadOnlyList<ChatCompletionMessage> messages,
        CancellationToken ct)
    {
        CompleteCalls.Add(messages.ToArray());
        if (_titleThrows)
            return Task.FromException<string>(new InvalidOperationException("title-fake"));
        return Task.FromResult(_titleResult);
    }
}
