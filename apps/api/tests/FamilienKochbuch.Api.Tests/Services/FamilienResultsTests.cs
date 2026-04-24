using System.Text.Json;
using FamilienKochbuch.Api.Services;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace FamilienKochbuch.Api.Tests.Services;

/// <summary>
/// Unit tests for the structured error helpers. These assert the wire
/// shape (lower-camel-cased <c>code</c> / <c>message</c> / optional
/// <c>details</c>) that the web client relies on.
/// </summary>
public class FamilienResultsTests
{
    [Fact]
    public async Task BadRequest_Returns_400_With_Code_And_Message()
    {
        var result = FamilienResults.BadRequest("invalid_input", "Title is required.");

        var body = await CaptureBodyAsync(result);

        Assert.Equal(400, body.statusCode);
        Assert.Equal("invalid_input", body.element.GetProperty("code").GetString());
        Assert.Equal("Title is required.", body.element.GetProperty("message").GetString());
        Assert.False(body.element.TryGetProperty("details", out _));
    }

    [Fact]
    public async Task BadRequest_With_Details_Serializes_Details_Object()
    {
        var result = FamilienResults.BadRequest(
            "invalid_input",
            "Invalid request payload.",
            details: new Dictionary<string, object>
            {
                ["field"] = "title",
                ["maxLength"] = 200,
            });

        var body = await CaptureBodyAsync(result);

        Assert.Equal(400, body.statusCode);
        Assert.True(body.element.TryGetProperty("details", out var details));
        Assert.Equal("title", details.GetProperty("field").GetString());
        Assert.Equal(200, details.GetProperty("maxLength").GetInt32());
    }

    [Fact]
    public async Task NotFound_Returns_404_With_Structured_Body()
    {
        var result = FamilienResults.NotFound("recipe_not_found", "Recipe not found.");

        var body = await CaptureBodyAsync(result);

        Assert.Equal(404, body.statusCode);
        Assert.Equal("recipe_not_found", body.element.GetProperty("code").GetString());
        Assert.Equal("Recipe not found.", body.element.GetProperty("message").GetString());
    }

    [Fact]
    public async Task Forbidden_Returns_403_With_Structured_Body()
    {
        var result = FamilienResults.Forbidden("not_a_member", "Access denied.");

        var body = await CaptureBodyAsync(result);

        Assert.Equal(403, body.statusCode);
        Assert.Equal("not_a_member", body.element.GetProperty("code").GetString());
    }

    [Fact]
    public async Task Conflict_Returns_409_With_Structured_Body()
    {
        var result = FamilienResults.Conflict("tag_exists", "Tag already exists.");

        var body = await CaptureBodyAsync(result);

        Assert.Equal(409, body.statusCode);
        Assert.Equal("tag_exists", body.element.GetProperty("code").GetString());
    }

    private static async Task<(int statusCode, JsonElement element)> CaptureBodyAsync(IResult result)
    {
        var recorder = new ResultRecorder();
        await result.ExecuteAsync(recorder.HttpContext);
        recorder.Body.Position = 0;
        using var doc = await JsonDocument.ParseAsync(recorder.Body);
        // Clone so the element outlives the using scope.
        return (recorder.HttpContext.Response.StatusCode, doc.RootElement.Clone());
    }

    private sealed class ResultRecorder
    {
        public DefaultHttpContext HttpContext { get; } = new();
        public MemoryStream Body { get; } = new();

        public ResultRecorder()
        {
            HttpContext.Response.Body = Body;
            var services = new ServiceCollection();
            services.AddLogging();
            HttpContext.RequestServices = services.BuildServiceProvider();
        }
    }
}
