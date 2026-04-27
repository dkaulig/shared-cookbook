using SharedCookbook.Infrastructure.Ai;

namespace SharedCookbook.Api.Services;

/// <summary>
/// CFG-1 — production <see cref="IAzureChatClientSettings"/> backed by
/// the <c>ExtractorConfig</c> registry. Reads
/// <c>llm.chat.max_completion_tokens</c> on every chat call so admin
/// overrides via <c>AdminExtractorConfigEndpoints</c> propagate to the
/// in-API chat client without a process restart.
///
/// <para>
/// Lives in the Api layer because it depends on
/// <see cref="IExtractorConfigReader"/>, which owns the EF query against
/// <c>AppDbContext</c>. The <see cref="AzureOpenAIChatClient"/> consumer
/// only sees the abstraction in <see cref="SharedCookbook.Infrastructure.Ai"/>,
/// so the layer arrow stays Api → Infrastructure (composition root
/// pattern).
/// </para>
///
/// <para>
/// Default fallback is <c>4096</c>, matching the post-v0.15.3 seeded
/// value for <c>llm.chat.max_completion_tokens</c>. When the registry
/// row is absent (brand-new DB, pre-CFG-0 migration) or non-numeric, we
/// behave as if the operator had left the seeded default — same shape
/// as the Python extractor's CFG-1 fallback semantics.
/// </para>
/// </summary>
public sealed class CfgAzureChatClientSettings : IAzureChatClientSettings
{
    private const string MaxCompletionTokensKey = "llm.chat.max_completion_tokens";
    private const int FallbackMaxCompletionTokens = 4096;

    private readonly IExtractorConfigReader _reader;

    public CfgAzureChatClientSettings(IExtractorConfigReader reader)
    {
        _reader = reader;
    }

    public Task<int> GetMaxCompletionTokensAsync(CancellationToken ct) =>
        _reader.GetIntAsync(MaxCompletionTokensKey, FallbackMaxCompletionTokens, ct);
}
