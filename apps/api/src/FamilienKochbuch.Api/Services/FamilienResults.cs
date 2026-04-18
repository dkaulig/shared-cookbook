using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Http;

namespace FamilienKochbuch.Api.Services;

/// <summary>
/// Uniform error-body shape returned by every 4xx/5xx JSON response from
/// the API. Mirrored by the TypeScript <c>ApiError</c> type in
/// <c>@familien-kochbuch/shared</c>.
/// </summary>
/// <param name="Code">
/// Stable machine-readable error code (snake_case). Clients key off this
/// to decide how to surface the error.
/// </param>
/// <param name="Message">
/// Human-readable German message safe to show to end users.
/// </param>
/// <param name="Details">
/// Optional structured payload — e.g. validation field names, limits,
/// or retry hints. Serialized as a nested JSON object when present.
/// </param>
public sealed record ErrorResponse(
    string Code,
    string Message,
    [property: JsonPropertyName("details"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    IReadOnlyDictionary<string, object>? Details = null);

/// <summary>
/// Helper factory for producing <see cref="IResult"/> values that embed
/// the uniform <see cref="ErrorResponse"/> envelope. Prefer these over
/// the raw <c>Results.BadRequest(new ErrorResponse(...))</c> pattern so
/// the wire shape never drifts.
/// </summary>
public static class FamilienResults
{
    // Shared serializer options — camelCase property names + drop nulls
    // so "details" only shows when a dictionary is supplied.
    internal static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    /// <summary>400 Bad Request with a <see cref="ErrorResponse"/> body.</summary>
    public static IResult BadRequest(
        string code,
        string message,
        IReadOnlyDictionary<string, object>? details = null)
        => Results.Json(new ErrorResponse(code, message, details), JsonOptions,
            statusCode: StatusCodes.Status400BadRequest);

    /// <summary>404 Not Found with a <see cref="ErrorResponse"/> body.</summary>
    public static IResult NotFound(
        string code,
        string message,
        IReadOnlyDictionary<string, object>? details = null)
        => Results.Json(new ErrorResponse(code, message, details), JsonOptions,
            statusCode: StatusCodes.Status404NotFound);

    /// <summary>403 Forbidden with a <see cref="ErrorResponse"/> body.</summary>
    public static IResult Forbidden(
        string code,
        string message,
        IReadOnlyDictionary<string, object>? details = null)
        => Results.Json(new ErrorResponse(code, message, details), JsonOptions,
            statusCode: StatusCodes.Status403Forbidden);

    /// <summary>409 Conflict with a <see cref="ErrorResponse"/> body.</summary>
    public static IResult Conflict(
        string code,
        string message,
        IReadOnlyDictionary<string, object>? details = null)
        => Results.Json(new ErrorResponse(code, message, details), JsonOptions,
            statusCode: StatusCodes.Status409Conflict);

    /// <summary>401 Unauthorized with a <see cref="ErrorResponse"/> body.</summary>
    public static IResult Unauthorized(
        string code,
        string message,
        IReadOnlyDictionary<string, object>? details = null)
        => Results.Json(new ErrorResponse(code, message, details), JsonOptions,
            statusCode: StatusCodes.Status401Unauthorized);

    /// <summary>500 Internal Server Error with a <see cref="ErrorResponse"/> body.</summary>
    public static IResult InternalServerError(
        string code,
        string message,
        IReadOnlyDictionary<string, object>? details = null)
        => Results.Json(new ErrorResponse(code, message, details), JsonOptions,
            statusCode: StatusCodes.Status500InternalServerError);
}
