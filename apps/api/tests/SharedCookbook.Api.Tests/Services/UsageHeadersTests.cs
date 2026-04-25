using System.Net;
using SharedCookbook.Api.Services;
using Xunit;

namespace SharedCookbook.Api.Tests.Services;

/// <summary>
/// Unit tests for <see cref="UsageHeaders.TryRead"/> — particularly the
/// model-deployment allowlist that defends the admin KI-usage
/// dashboard against bucket spoofing from a misconfigured / hostile
/// Python service (security-review Vuln 1).
/// </summary>
public class UsageHeadersTests
{
    private static HttpResponseMessage BuildResponse(
        string? prompt = "1500",
        string? completion = "400",
        string? cached = "800",
        string? model = "gpt-5.1-chat")
    {
        var resp = new HttpResponseMessage(HttpStatusCode.OK);
        if (prompt is not null) resp.Headers.Add(UsageHeaders.PromptTokensHeader, prompt);
        if (completion is not null) resp.Headers.Add(UsageHeaders.CompletionTokensHeader, completion);
        if (cached is not null) resp.Headers.Add(UsageHeaders.CachedTokensHeader, cached);
        if (model is not null) resp.Headers.Add(UsageHeaders.ModelHeader, model);
        return resp;
    }

    [Fact]
    public void Valid_Headers_Parse_With_Model_Preserved()
    {
        using var resp = BuildResponse();

        var ok = UsageHeaders.TryRead(resp, out var p, out var c, out var cp, out var model);

        Assert.True(ok);
        Assert.Equal(1500, p);
        Assert.Equal(400, c);
        Assert.Equal(800, cp);
        Assert.Equal("gpt-5.1-chat", model);
    }

    [Theory]
    [InlineData("gpt-4.1")]
    [InlineData("gpt-4.1-mini")]
    [InlineData("gpt_5.1_chat")]
    [InlineData("MODEL-123")]
    [InlineData("a")]
    public void Model_Passing_Allowlist_Is_Returned_Verbatim(string model)
    {
        using var resp = BuildResponse(model: model);

        var ok = UsageHeaders.TryRead(resp, out _, out _, out _, out var returned);

        Assert.True(ok);
        Assert.Equal(model, returned);
    }

    [Fact]
    public void Oversized_Model_Is_Replaced_With_Unknown_Sentinel()
    {
        // 65 chars — one over the regex cap.
        var oversize = new string('a', 65);
        using var resp = BuildResponse(model: oversize);

        var ok = UsageHeaders.TryRead(resp, out _, out _, out _, out var model);

        Assert.True(ok);
        Assert.Equal(UsageHeaders.UnknownModelSentinel, model);
    }

    [Theory]
    [InlineData("gpt 5.1")]          // space
    [InlineData("gpt/5.1")]          // slash
    [InlineData("gpt\t5.1")]         // tab (control char)
    [InlineData("gpt\n5.1")]         // newline (control char)
    [InlineData("gpt;drop table")]   // semicolon + SQL-ish noise
    [InlineData("модель")]           // non-ASCII letters
    public void Model_With_Disallowed_Chars_Is_Replaced_With_Unknown_Sentinel(string badModel)
    {
        // Note: HttpResponseMessage.Headers.Add rejects raw control chars
        // itself; we inject via TryAddWithoutValidation for those cases.
        var resp = new HttpResponseMessage(HttpStatusCode.OK);
        resp.Headers.Add(UsageHeaders.PromptTokensHeader, "10");
        resp.Headers.Add(UsageHeaders.CompletionTokensHeader, "5");
        resp.Headers.Add(UsageHeaders.CachedTokensHeader, "0");
        // TryAddWithoutValidation lets us inject whatever bytes the
        // Python side might emit in a pathological scenario.
        resp.Headers.TryAddWithoutValidation(UsageHeaders.ModelHeader, badModel);

        try
        {
            var ok = UsageHeaders.TryRead(resp, out _, out _, out _, out var model);
            Assert.True(ok);
            Assert.Equal(UsageHeaders.UnknownModelSentinel, model);
        }
        finally
        {
            resp.Dispose();
        }
    }

    [Fact]
    public void Missing_Model_Header_Fails_The_Read()
    {
        using var resp = BuildResponse(model: null);

        var ok = UsageHeaders.TryRead(resp, out _, out _, out _, out _);

        Assert.False(ok);
    }

    [Fact]
    public void Missing_Numeric_Header_Fails_The_Read()
    {
        using var resp = BuildResponse(prompt: null);

        var ok = UsageHeaders.TryRead(resp, out _, out _, out _, out _);

        Assert.False(ok);
    }

    [Fact]
    public void Cached_Exceeding_Prompt_Fails_The_Read()
    {
        // Would trip RecordUsage's domain throw; guard here avoids it.
        using var resp = BuildResponse(prompt: "100", cached: "200");

        var ok = UsageHeaders.TryRead(resp, out _, out _, out _, out _);

        Assert.False(ok);
    }

    [Fact]
    public void Negative_Token_Counts_Fail_The_Read()
    {
        using var resp = BuildResponse(prompt: "-1");

        var ok = UsageHeaders.TryRead(resp, out _, out _, out _, out _);

        Assert.False(ok);
    }
}
