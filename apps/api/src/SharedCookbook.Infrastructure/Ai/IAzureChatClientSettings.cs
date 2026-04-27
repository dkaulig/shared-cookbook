namespace SharedCookbook.Infrastructure.Ai;

/// <summary>
/// CFG-1 seam — async lookup for the chat client's per-call settings
/// (today: <c>max_completion_tokens</c>) sourced from the
/// <c>ExtractorConfig</c> registry. Lives in the Infrastructure layer so
/// <see cref="AzureOpenAIChatClient"/> can depend on it without taking
/// a reverse-layer reference on the Api project where the registry's
/// reader lives. The composition root binds this interface to a real
/// implementation that wraps <c>IExtractorConfigReader</c>; tests pass a
/// stub that returns a fixed value.
///
/// <para>
/// Implementations resolve a fresh value on every call. The chat client
/// awaits this once per <c>StreamAsync</c> / <c>CompleteAsync</c>
/// invocation, so admin overrides take effect within a request — no
/// process restart needed. The caller-side default (when the registry
/// row is missing or unreadable) is the implementation's concern; the
/// chat client only sees the resolved <see cref="int"/>.
/// </para>
/// </summary>
public interface IAzureChatClientSettings
{
    /// <summary>
    /// Resolve the current cap to send as the request's
    /// <c>max_completion_tokens</c> field. Awaited once per chat call;
    /// implementations are expected to be cheap (a single PK lookup
    /// against Postgres or an in-memory cache hit).
    /// </summary>
    Task<int> GetMaxCompletionTokensAsync(CancellationToken ct);
}
