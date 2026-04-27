using SharedCookbook.Api.Jobs;
using Xunit;

namespace SharedCookbook.Api.Tests.Jobs;

/// <summary>
/// Direct unit tests for
/// <see cref="ExtractRecipeFromUrlJob.TryReadAiNormalizeActive(string, out bool)"/>.
///
/// The integration suite at <c>ExtractRecipeFromUrlJobTests</c> only
/// exercises the absent-snapshot and snapshot-with-true paths. These
/// tests pin the helper's documented "graceful failure" contract for
/// the negative cases — null / empty / malformed JSON / wrong types —
/// so a future maintainer who tightens or loosens the parser sees the
/// regression at the helper level instead of via a job-level crash.
/// </summary>
public class TryReadAiNormalizeActiveTests
{
    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("not json")]
    [InlineData("{")]
    [InlineData("[1, 2, 3]")]                                  // Root is array, not object
    [InlineData("\"a string\"")]                               // Root is scalar
    [InlineData("{}")]                                         // No config_snapshot key
    [InlineData("{\"config_snapshot\":null}")]                 // Snapshot present but null
    [InlineData("{\"config_snapshot\":\"oops\"}")]             // Snapshot is wrong-typed
    [InlineData("{\"config_snapshot\":{}}")]                   // Snapshot lacks the field
    [InlineData("{\"config_snapshot\":{\"ai_normalize_active\":\"true\"}}")]  // String, not bool
    [InlineData("{\"config_snapshot\":{\"ai_normalize_active\":1}}")]         // Number, not bool
    [InlineData("{\"config_snapshot\":{\"ai_normalize_active\":null}}")]      // Explicit null
    [InlineData("{\"config_snapshot\":{\"ai_normalize_active\":false}}")]     // JSON false
    public void Returns_False_With_OutParam_False_For_Negative_Or_FalseFlag_Inputs(string? input)
    {
        var ok = ExtractRecipeFromUrlJob.TryReadAiNormalizeActive(input!, out var active);

        // The helper's contract: callers should treat both `false` outcomes
        // as "no audit signal, leave the row untouched". The JSON-`false`
        // case is the one exception where the parser DID find a usable
        // value — but the value itself is `false`, so the row stays at
        // its existing default-`false` either way.
        Assert.False(active);
        if (input is "{\"config_snapshot\":{\"ai_normalize_active\":false}}")
        {
            Assert.True(ok);
        }
        else
        {
            Assert.False(ok);
        }
    }

    [Fact]
    public void Returns_True_With_OutParam_True_When_Flag_Is_Json_True()
    {
        const string json = "{\"config_snapshot\":{\"ai_normalize_active\":true}}";

        var ok = ExtractRecipeFromUrlJob.TryReadAiNormalizeActive(json, out var active);

        Assert.True(ok);
        Assert.True(active);
    }
}
