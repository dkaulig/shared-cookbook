using SharedCookbook.Domain.Entities;
using Xunit;

namespace SharedCookbook.Domain.Tests.Entities;

/// <summary>
/// CFG-1 — guards the hardcoded extractor-config defaults registered in
/// <see cref="ExtractorConfigDefaults"/>. The
/// <c>max_completion_tokens</c> defaults are load-bearing: the v0.15.2
/// truncation fix bumped the Python-side fallback constant from
/// <c>2048</c> → <c>4096</c>, but the CFG-1 admin override layer reads
/// the value from the API's DB-backed registry whose seed lives here.
/// If this drifts back to <c>2048</c> the truncation reproduces.
/// </summary>
public class ExtractorConfigDefaultsTests
{
    [Theory]
    [InlineData("llm.structured.max_completion_tokens")]
    [InlineData("llm.chat.max_completion_tokens")]
    [InlineData("llm.vision.max_completion_tokens")]
    public void MaxCompletionTokens_Defaults_To_4096(string key)
    {
        Assert.True(
            ExtractorConfigDefaults.ByKey.TryGetValue(key, out var entry),
            $"Expected key '{key}' to be registered in ExtractorConfigDefaults.All.");

        Assert.Equal(ExtractorConfigValueType.Int, entry!.ValueType);
        Assert.Equal("4096", entry.DefaultValueJson);
    }
}
