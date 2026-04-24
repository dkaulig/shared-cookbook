using System.Text.Json;
using FamilienKochbuch.Api.Services;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace FamilienKochbuch.Api.Tests.Services;

/// <summary>
/// REL-4 — unit tests for the canonical <see cref="ErrorCodes"/> enum +
/// the enriched <see cref="ErrorResponse"/> wire shape. The shape is an
/// OSS contract: every 4xx/5xx body from this API serialises as
/// <c>{ code, message, status, fieldName?, details? }</c>. These tests
/// are the regression-safety net that prevents accidental drift.
/// </summary>
public class ErrorCodesTests
{
    // ── Code catalog — every value is snake_case, non-empty, stable ──

    [Fact]
    public void ErrorCodes_Are_Non_Empty_Snake_Case()
    {
        // Sample a handful of codes that every endpoint layer keys off.
        // A compile-time assertion on the whole enum is impossible
        // because these are `const string`, but the enum type exists
        // purely so tests can assert discoverable membership of the
        // stable set REL-3 (i18n) and REL-5 (error classifier) consume.
        string[] everyCode = [
            ErrorCodes.InvalidValue,
            ErrorCodes.MissingField,
            ErrorCodes.InvalidInput,
            ErrorCodes.Unauthorized,
            ErrorCodes.Forbidden,
            ErrorCodes.InvalidCredentials,
            ErrorCodes.NotFound,
            ErrorCodes.VersionMismatch,
            ErrorCodes.RateLimited,
            ErrorCodes.InternalError,
            ErrorCodes.ServiceUnavailable,
            ErrorCodes.AiServiceUnavailable,
            ErrorCodes.AiDisabled,
            ErrorCodes.ExtractorInternal,
        ];

        foreach (var code in everyCode)
        {
            Assert.False(string.IsNullOrWhiteSpace(code));
            Assert.Matches("^[a-z][a-z0-9_]*$", code);
        }
    }

    // ── ErrorResponse wire shape — new fields ────────────────────────

    [Fact]
    public async Task BadRequest_Emits_Status_Field_Matching_Http_Status()
    {
        var result = FamilienResults.BadRequest(
            ErrorCodes.InvalidValue, "Value is out of range.");

        var body = await CaptureAsync(result);

        Assert.Equal(400, body.statusCode);
        Assert.Equal(400, body.element.GetProperty("status").GetInt32());
    }

    [Fact]
    public async Task BadRequest_With_FieldName_Serialises_Camel_Cased()
    {
        var result = FamilienResults.BadRequest(
            ErrorCodes.InvalidValue,
            "Value is out of range.",
            fieldName: "servings");

        var body = await CaptureAsync(result);

        Assert.Equal(400, body.statusCode);
        Assert.Equal("servings", body.element.GetProperty("fieldName").GetString());
    }

    [Fact]
    public async Task BadRequest_Without_FieldName_Omits_The_Field()
    {
        var result = FamilienResults.BadRequest(
            ErrorCodes.InvalidInput, "Invalid request payload.");

        var body = await CaptureAsync(result);

        Assert.False(body.element.TryGetProperty("fieldName", out _));
    }

    [Fact]
    public async Task NotFound_Body_Contains_Status_404_And_No_FieldName()
    {
        var result = FamilienResults.NotFound(
            ErrorCodes.NotFound, "Recipe not found.");

        var body = await CaptureAsync(result);

        Assert.Equal(404, body.statusCode);
        Assert.Equal(404, body.element.GetProperty("status").GetInt32());
        Assert.False(body.element.TryGetProperty("fieldName", out _));
    }

    [Fact]
    public async Task Conflict_Body_Contains_Status_409()
    {
        var result = FamilienResults.Conflict(
            ErrorCodes.VersionMismatch, "Version mismatch; reload and retry.");

        var body = await CaptureAsync(result);

        Assert.Equal(409, body.statusCode);
        Assert.Equal(409, body.element.GetProperty("status").GetInt32());
    }

    [Fact]
    public async Task Conflict_With_Current_Projection_Still_Carries_Status()
    {
        var result = FamilienResults.Conflict(
            ErrorCodes.VersionMismatch,
            "Version mismatch; reload and retry.",
            current: new { id = 42 });

        var body = await CaptureAsync(result);

        Assert.Equal(409, body.statusCode);
        Assert.Equal(409, body.element.GetProperty("status").GetInt32());
        Assert.Equal(42, body.element.GetProperty("current").GetProperty("id").GetInt32());
    }

    [Fact]
    public async Task Forbidden_Body_Contains_Status_403()
    {
        var result = FamilienResults.Forbidden(
            ErrorCodes.Forbidden, "Insufficient permissions.");

        var body = await CaptureAsync(result);

        Assert.Equal(403, body.statusCode);
        Assert.Equal(403, body.element.GetProperty("status").GetInt32());
    }

    [Fact]
    public async Task Unauthorized_Body_Contains_Status_401()
    {
        var result = FamilienResults.Unauthorized(
            ErrorCodes.InvalidCredentials, "Email or password invalid.");

        var body = await CaptureAsync(result);

        Assert.Equal(401, body.statusCode);
        Assert.Equal(401, body.element.GetProperty("status").GetInt32());
    }

    [Fact]
    public async Task Gone_Body_Contains_Status_410()
    {
        var result = FamilienResults.Gone(
            ErrorCodes.CandidatesExpired, "Import candidates no longer available.");

        var body = await CaptureAsync(result);

        Assert.Equal(410, body.statusCode);
        Assert.Equal(410, body.element.GetProperty("status").GetInt32());
    }

    [Fact]
    public async Task InternalServerError_Body_Contains_Status_500()
    {
        var result = FamilienResults.InternalServerError(
            ErrorCodes.InternalError, "An unexpected error occurred.");

        var body = await CaptureAsync(result);

        Assert.Equal(500, body.statusCode);
        Assert.Equal(500, body.element.GetProperty("status").GetInt32());
    }

    [Fact]
    public async Task ServiceUnavailable_Body_Contains_Status_503()
    {
        var result = FamilienResults.ServiceUnavailable(
            ErrorCodes.AiDisabled, "AI features are currently disabled.");

        var body = await CaptureAsync(result);

        Assert.Equal(503, body.statusCode);
        Assert.Equal(503, body.element.GetProperty("status").GetInt32());
    }

    // ── Helpers ──────────────────────────────────────────────────────

    private static async Task<(int statusCode, JsonElement element)> CaptureAsync(IResult result)
    {
        var ctx = new DefaultHttpContext
        {
            RequestServices = new ServiceCollection().AddLogging().BuildServiceProvider(),
        };
        var body = new MemoryStream();
        ctx.Response.Body = body;
        await result.ExecuteAsync(ctx);
        body.Position = 0;
        using var doc = await JsonDocument.ParseAsync(body);
        return (ctx.Response.StatusCode, doc.RootElement.Clone());
    }
}
