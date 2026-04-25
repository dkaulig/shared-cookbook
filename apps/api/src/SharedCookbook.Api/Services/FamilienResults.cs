using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Http;

namespace SharedCookbook.Api.Services;

/// <summary>
/// Uniform error-body shape returned by every 4xx/5xx JSON response from
/// the API. Mirrored by the TypeScript <c>ApiError</c> type in
/// <c>@shared-cookbook/shared</c>.
///
/// <para>REL-4 — the shape carries five well-known fields:</para>
/// <list type="bullet">
/// <item><c>code</c> — stable machine-readable identifier
/// (snake_case). See <see cref="ErrorCodes"/> for the catalogue.</item>
/// <item><c>message</c> — English developer-facing string. End-user
/// strings are the frontend's concern (REL-3 i18n).</item>
/// <item><c>status</c> — HTTP status mirror. Always set, matches the
/// transport-layer status so an API consumer inspecting only the body
/// gets the same signal.</item>
/// <item><c>fieldName</c> — optional. Populated on 400-validation
/// errors when a single field is at fault; omitted otherwise.</item>
/// <item><c>details</c> — optional. Structured payload for
/// forward-compat (validation multi-field hints, retry timings).</item>
/// </list>
/// </summary>
/// <param name="Code">
/// Stable machine-readable error code (snake_case). Clients key off this
/// to decide how to surface the error.
/// </param>
/// <param name="Message">
/// English developer-facing message. Safe to log / display in an API
/// console, but NOT shown to end users — the frontend translates
/// <paramref name="Code"/> to localised copy.
/// </param>
/// <param name="Status">HTTP status mirror, always set.</param>
/// <param name="FieldName">
/// Optional. Names the single field at fault for 400-validation errors;
/// null / omitted for every other error category.
/// </param>
/// <param name="Details">
/// Optional structured payload — e.g. validation multi-field hints,
/// retry timings. Serialised as a nested JSON object when present.
/// </param>
public sealed record ErrorResponse(
    string Code,
    string Message,
    int Status,
    [property: JsonPropertyName("fieldName"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    string? FieldName = null,
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
    // so optional fields ("fieldName", "details") only show when set.
    // Public so sibling helpers (e.g. PythonProxyErrorMapper) can
    // emit ErrorResponse envelopes with identical serialisation rules.
    public static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    /// <summary>400 Bad Request with a <see cref="ErrorResponse"/> body.</summary>
    public static IResult BadRequest(
        string code,
        string message,
        string? fieldName = null,
        IReadOnlyDictionary<string, object>? details = null)
        => Results.Json(
            new ErrorResponse(code, message, StatusCodes.Status400BadRequest, fieldName, details),
            JsonOptions,
            statusCode: StatusCodes.Status400BadRequest);

    /// <summary>404 Not Found with a <see cref="ErrorResponse"/> body.</summary>
    public static IResult NotFound(
        string code,
        string message,
        IReadOnlyDictionary<string, object>? details = null)
        => Results.Json(
            new ErrorResponse(code, message, StatusCodes.Status404NotFound, FieldName: null, details),
            JsonOptions,
            statusCode: StatusCodes.Status404NotFound);

    /// <summary>403 Forbidden with a <see cref="ErrorResponse"/> body.</summary>
    public static IResult Forbidden(
        string code,
        string message,
        IReadOnlyDictionary<string, object>? details = null)
        => Results.Json(
            new ErrorResponse(code, message, StatusCodes.Status403Forbidden, FieldName: null, details),
            JsonOptions,
            statusCode: StatusCodes.Status403Forbidden);

    /// <summary>409 Conflict with a <see cref="ErrorResponse"/> body.</summary>
    public static IResult Conflict(
        string code,
        string message,
        IReadOnlyDictionary<string, object>? details = null)
        => Results.Json(
            new ErrorResponse(code, message, StatusCodes.Status409Conflict, FieldName: null, details),
            JsonOptions,
            statusCode: StatusCodes.Status409Conflict);

    /// <summary>
    /// 409 Conflict with a <c>{ code, message, status, current }</c>
    /// body. OFF3 mutation endpoints return the caller's current view of
    /// the entity under <c>current</c> so the conflict-resolution UI can
    /// render "this is what the server has now" without an extra GET.
    /// When <paramref name="current"/> is <c>null</c> the field is
    /// omitted from the body (same convention as <c>details</c> on the
    /// standard <see cref="ErrorResponse"/>).
    /// </summary>
    public static IResult Conflict(
        string code,
        string message,
        object? current)
        => Results.Json(
            new ConflictWithCurrent(code, message, StatusCodes.Status409Conflict, current),
            JsonOptions,
            statusCode: StatusCodes.Status409Conflict);

    /// <summary>
    /// Wire shape for <see cref="Conflict(string, string, object?)"/>. The
    /// <c>current</c> field holds the server's authoritative projection of
    /// the entity at the moment the conflict was detected.
    /// </summary>
    private sealed record ConflictWithCurrent(
        string Code,
        string Message,
        int Status,
        [property: JsonPropertyName("current"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        object? Current);

    /// <summary>401 Unauthorized with a <see cref="ErrorResponse"/> body.</summary>
    public static IResult Unauthorized(
        string code,
        string message,
        IReadOnlyDictionary<string, object>? details = null)
        => Results.Json(
            new ErrorResponse(code, message, StatusCodes.Status401Unauthorized, FieldName: null, details),
            JsonOptions,
            statusCode: StatusCodes.Status401Unauthorized);

    /// <summary>
    /// 410 Gone with a <see cref="ErrorResponse"/> body. Used when a
    /// resource that existed has been intentionally cleaned up (e.g.
    /// the COVER-0 sweep reaped import candidates) so the client can
    /// disambiguate from a 404 (never existed) and stop polling.
    /// </summary>
    public static IResult Gone(
        string code,
        string message,
        IReadOnlyDictionary<string, object>? details = null)
        => Results.Json(
            new ErrorResponse(code, message, StatusCodes.Status410Gone, FieldName: null, details),
            JsonOptions,
            statusCode: StatusCodes.Status410Gone);

    /// <summary>500 Internal Server Error with a <see cref="ErrorResponse"/> body.</summary>
    public static IResult InternalServerError(
        string code,
        string message,
        IReadOnlyDictionary<string, object>? details = null)
        => Results.Json(
            new ErrorResponse(code, message, StatusCodes.Status500InternalServerError, FieldName: null, details),
            JsonOptions,
            statusCode: StatusCodes.Status500InternalServerError);

    /// <summary>
    /// 503 Service Unavailable with a <see cref="ErrorResponse"/> body.
    /// CFG-3 callsite: feature-flag kill-switches hit via
    /// <see cref="IExtractorConfigReader"/> return this code when an
    /// admin has flipped the flag off in the admin UI, so the frontend
    /// can surface "aktuell deaktiviert" consistently across endpoints.
    /// </summary>
    public static IResult ServiceUnavailable(
        string code,
        string message,
        IReadOnlyDictionary<string, object>? details = null)
        => Results.Json(
            new ErrorResponse(code, message, StatusCodes.Status503ServiceUnavailable, FieldName: null, details),
            JsonOptions,
            statusCode: StatusCodes.Status503ServiceUnavailable);
}
