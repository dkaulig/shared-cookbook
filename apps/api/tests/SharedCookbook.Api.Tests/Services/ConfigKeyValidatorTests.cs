using System.Text.Json;
using SharedCookbook.Api.Services;
using Xunit;

namespace SharedCookbook.Api.Tests.Services;

/// <summary>
/// CFG-0 — unit tests for <see cref="ConfigKeyValidator"/>. Covers
/// every rule category (prompt length, deployment-name regex, int /
/// float bounds, bool type check, string_list caps) plus the
/// unknown-key path. Endpoint-level behaviour is covered by
/// <see cref="Endpoints.AdminExtractorConfigEndpointsTests"/>.
/// </summary>
public class ConfigKeyValidatorTests
{
    private readonly ConfigKeyValidator _validator = new();

    private static JsonElement Json(object v) =>
        JsonDocument.Parse(JsonSerializer.Serialize(v)).RootElement.Clone();

    [Fact]
    public void Unknown_Key_Fails()
    {
        var result = _validator.Validate("does.not.exist", Json(1));
        Assert.False(result.IsValid);
    }

    [Fact]
    public void Temperature_In_Range_Passes()
    {
        var result = _validator.Validate("llm.structured.temperature", Json(0.5));
        Assert.True(result.IsValid);
        Assert.Equal("0.5", result.NormalizedJson);
    }

    [Theory]
    [InlineData(-0.1)]
    [InlineData(2.1)]
    public void Temperature_Out_Of_Range_Fails(double value)
    {
        var result = _validator.Validate("llm.structured.temperature", Json(value));
        Assert.False(result.IsValid);
    }

    [Fact]
    public void MaxCompletionTokens_Above_Cap_Fails()
    {
        var result = _validator.Validate("llm.structured.max_completion_tokens", Json(99_999));
        Assert.False(result.IsValid);
    }

    [Fact]
    public void MaxCompletionTokens_At_Cap_Passes()
    {
        var result = _validator.Validate(
            "llm.structured.max_completion_tokens",
            Json(ConfigKeyValidator.MaxCompletionTokens));
        Assert.True(result.IsValid);
    }

    [Fact]
    public void Prompt_Exactly_Min_Chars_Passes()
    {
        var prompt = new string('a', ConfigKeyValidator.MinPromptChars);
        var result = _validator.Validate("llm.chat_to_recipe.system_prompt", Json(prompt));
        Assert.True(result.IsValid);
    }

    [Fact]
    public void Prompt_Below_Min_Fails()
    {
        var prompt = new string('a', ConfigKeyValidator.MinPromptChars - 1);
        var result = _validator.Validate("llm.chat_to_recipe.system_prompt", Json(prompt));
        Assert.False(result.IsValid);
    }

    [Fact]
    public void Prompt_Above_Max_Fails()
    {
        var prompt = new string('a', ConfigKeyValidator.MaxPromptChars + 1);
        var result = _validator.Validate("llm.chat_to_recipe.system_prompt", Json(prompt));
        Assert.False(result.IsValid);
    }

    [Theory]
    [InlineData("gpt-4.1-mini")]
    [InlineData("gpt-5.1-chat")]
    [InlineData("gpt-4o")]
    public void Deployment_Name_Valid(string name)
    {
        var result = _validator.Validate("llm.structured.deployment", Json(name));
        Assert.True(result.IsValid);
    }

    [Theory]
    [InlineData("GPT-4")]       // uppercase rejected
    [InlineData("-bad-start")]  // leading dash
    [InlineData("a")]           // too short
    [InlineData("gpt with space")]
    public void Deployment_Name_Invalid(string name)
    {
        var result = _validator.Validate("llm.structured.deployment", Json(name));
        Assert.False(result.IsValid);
    }

    [Fact]
    public void Bool_Flag_Accepts_True_False()
    {
        Assert.True(_validator.Validate("feature.chat_enabled", Json(true)).IsValid);
        Assert.True(_validator.Validate("feature.chat_enabled", Json(false)).IsValid);
    }

    [Fact]
    public void Bool_Flag_Rejects_String_Yes()
    {
        Assert.False(_validator.Validate("feature.chat_enabled", Json("yes")).IsValid);
    }

    [Fact]
    public void StringList_Within_Limits_Passes()
    {
        var result = _validator.Validate(
            "pipeline.shortener_hosts",
            Json(new[] { "bit.ly", "t.co" }));
        Assert.True(result.IsValid);
    }

    [Fact]
    public void StringList_With_Empty_Item_Fails()
    {
        var result = _validator.Validate(
            "pipeline.shortener_hosts",
            Json(new[] { "bit.ly", "" }));
        Assert.False(result.IsValid);
    }

    [Fact]
    public void StringList_Over_50_Items_Fails()
    {
        var items = Enumerable.Range(0, 51).Select(i => $"host-{i}.tld").ToArray();
        var result = _validator.Validate("pipeline.shortener_hosts", Json(items));
        Assert.False(result.IsValid);
    }

    [Fact]
    public void StringList_Overlong_Item_Fails()
    {
        var items = new[] { new string('x', ConfigKeyValidator.StringListItemMaxLength + 1) };
        var result = _validator.Validate("pipeline.shortener_hosts", Json(items));
        Assert.False(result.IsValid);
    }

    [Fact]
    public void ShortenerTimeout_Below_Min_Fails()
    {
        var result = _validator.Validate(
            "pipeline.shortener_head_timeout_seconds", Json(0.1));
        Assert.False(result.IsValid);
    }

    [Fact]
    public void MinTranscriptChars_Zero_Fails()
    {
        var result = _validator.Validate("pipeline.min_transcript_chars", Json(0));
        Assert.False(result.IsValid);
    }
}
