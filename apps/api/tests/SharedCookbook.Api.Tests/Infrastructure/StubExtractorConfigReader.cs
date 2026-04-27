using SharedCookbook.Api.Services;

namespace SharedCookbook.Api.Tests.Infrastructure;

/// <summary>
/// CFG-3 — deterministic test double for <see cref="IExtractorConfigReader"/>.
/// Per-key returns are scripted via <see cref="Set"/>; keys that were
/// not set use the caller's <c>defaultValue</c>, matching the real
/// implementation's row-missing-fallback contract.
/// </summary>
public sealed class StubExtractorConfigReader : IExtractorConfigReader
{
    private readonly Dictionary<string, bool> _flags = new(StringComparer.Ordinal);
    private readonly Dictionary<string, int> _ints = new(StringComparer.Ordinal);

    /// <summary>Fluent setter. Returns <c>this</c> so several flags can
    /// be configured in a single statement.</summary>
    public StubExtractorConfigReader Set(string key, bool value)
    {
        _flags[key] = value;
        return this;
    }

    /// <summary>Fluent setter for int-typed config keys (e.g.
    /// <c>llm.chat.max_completion_tokens</c>).</summary>
    public StubExtractorConfigReader Set(string key, int value)
    {
        _ints[key] = value;
        return this;
    }

    public Task<bool> GetFeatureFlagAsync(
        string key, bool defaultValue, CancellationToken ct)
    {
        if (_flags.TryGetValue(key, out var value)) return Task.FromResult(value);
        return Task.FromResult(defaultValue);
    }

    public Task<int> GetIntAsync(
        string key, int defaultValue, CancellationToken ct)
    {
        if (_ints.TryGetValue(key, out var value)) return Task.FromResult(value);
        return Task.FromResult(defaultValue);
    }
}
