using System.Net;
using System.Net.Http;
using System.Text.Json;

namespace SharedCookbook.Api.Services;

/// <summary>
/// Central translator from Python extractor HTTP outcomes to .NET
/// user-facing responses. Owns three concerns:
///
/// <list type="bullet">
/// <item>Status-code mapping. FastAPI idioms (422 for invalid input)
/// get folded to .NET conventions (400); transport + 5xx paths carry
/// the "try again" hint; 401 is masked as a 500 because HMAC drift is
/// our bug, not the caller's.</item>
/// <item>Error-body parsing. FastAPI returns <c>{ "detail": "..." }</c>;
/// we pull the message out and re-wrap it in our uniform
/// <see cref="ErrorResponse"/> shape via <see cref="FamilienResults"/>.</item>
/// <item>Message sanitising. 401 (HMAC mismatch) MUST NOT leak the
/// Python-side detail — surface the generic "internal error" copy
/// instead.</item>
/// </list>
///
/// Used by the three P2-6 synchronous proxy endpoints (POST /api/chat,
/// POST /api/chat/{sid}/to-recipe) and reserved for any future
/// proxy-style bridge endpoints. The async Hangfire path has its own
/// <see cref="SharedCookbook.Api.Jobs.PythonExtractorException"/>
/// flow because it doesn't render HTTP directly to the caller.
/// </summary>
public static class PythonProxyErrorMapper
{
    /// <summary>English developer-facing copy used for Python 503 and
    /// transport failures. Public so tests can pin the exact wording.</summary>
    public const string AiServiceUnavailableMessage =
        "AI service is temporarily unavailable. Please retry shortly.";

    /// <summary>Generic 500 copy when Python returned 401 (HMAC drift)
    /// or any other response we don't want to leak.</summary>
    public const string InternalErrorMessage =
        "Internal error while contacting the AI backend.";

    /// <summary>Generic 502 copy for malformed / surprise responses.</summary>
    public const string BadGatewayMessage =
        "AI service returned an unexpected response. Please retry.";

    /// <summary>
    /// Translates a completed Python <see cref="HttpResponseMessage"/>
    /// into an <see cref="IResult"/> the proxy endpoint can return.
    ///
    /// Preconditions: <paramref name="response"/> is non-success (2xx
    /// responses must be passed through directly, not via this helper).
    /// </summary>
    /// <param name="response">The Python response (already
    /// non-success).</param>
    /// <param name="bodyText">The already-read response body. Passed
    /// in explicitly so the caller doesn't have to hand us a disposed
    /// HttpContent.</param>
    public static IResult MapErrorResponse(HttpResponseMessage response, string bodyText)
    {
        var status = (int)response.StatusCode;
        var detail = TryExtractDetail(bodyText);

        // Python 401 = HMAC mismatch. Internal. Never leak.
        if (status == StatusCodes.Status401Unauthorized)
        {
            return FamilienResults.InternalServerError(
                ErrorCodes.ExtractorInternal, InternalErrorMessage);
        }

        // 503 from Python = LLM outage / rate-limit. Pass through with
        // our canonical English copy (don't trust Python's exact wording
        // in case future versions change it).
        if (status == StatusCodes.Status503ServiceUnavailable)
        {
            return Results.Json(
                new ErrorResponse(
                    ErrorCodes.AiServiceUnavailable,
                    AiServiceUnavailableMessage,
                    StatusCodes.Status503ServiceUnavailable),
                FamilienResults.JsonOptions,
                statusCode: StatusCodes.Status503ServiceUnavailable);
        }

        // 413 passes through unchanged (detail from Python if provided,
        // generic fallback otherwise). Python owns the detail copy —
        // it's the authoritative voice on "which size limit tripped".
        if (status == StatusCodes.Status413PayloadTooLarge)
        {
            var msg = detail ?? "Payload too large.";
            return Results.Json(
                new ErrorResponse(
                    ErrorCodes.PayloadTooLarge,
                    msg,
                    StatusCodes.Status413PayloadTooLarge),
                FamilienResults.JsonOptions,
                statusCode: StatusCodes.Status413PayloadTooLarge);
        }

        // FastAPI uses 422 for invalid input; .NET + the web surface
        // prefer 400 so the frontend's error-mapping table stays
        // shorter.
        if (status == StatusCodes.Status400BadRequest
            || status == StatusCodes.Status422UnprocessableEntity)
        {
            return FamilienResults.BadRequest(
                ErrorCodes.InvalidInput,
                detail ?? "Invalid request payload.");
        }

        // Any other 4xx — pass through verbatim in terms of status,
        // with the Python detail as message.
        if (status >= 400 && status < 500)
        {
            return Results.Json(
                new ErrorResponse(
                    ErrorCodes.ExtractorClientError,
                    detail ?? $"HTTP {status}",
                    status),
                FamilienResults.JsonOptions,
                statusCode: status);
        }

        // 500 + other 5xx — the extractor failed. 502 Bad Gateway is the
        // honest signal; add the retry-later hint so the UI can show
        // the right message.
        return Results.Json(
            new ErrorResponse(
                ErrorCodes.ExtractorBadGateway,
                BadGatewayMessage,
                StatusCodes.Status502BadGateway),
            FamilienResults.JsonOptions,
            statusCode: StatusCodes.Status502BadGateway);
    }

    /// <summary>Response for network-level failures (connection refused,
    /// timeout, DNS). Always a 502 with the retry hint.</summary>
    public static IResult MapTransportFailure()
    {
        return Results.Json(
            new ErrorResponse(
                ErrorCodes.ExtractorUnreachable,
                AiServiceUnavailableMessage,
                StatusCodes.Status502BadGateway),
            FamilienResults.JsonOptions,
            statusCode: StatusCodes.Status502BadGateway);
    }

    /// <summary>
    /// Pulls the FastAPI-convention <c>detail</c> string out of a JSON
    /// body. Returns null when the body is blank / not JSON / doesn't
    /// follow the convention.
    /// </summary>
    private static string? TryExtractDetail(string? bodyText)
    {
        if (string.IsNullOrWhiteSpace(bodyText)) return null;
        try
        {
            using var doc = JsonDocument.Parse(bodyText);
            if (doc.RootElement.ValueKind != JsonValueKind.Object) return null;
            if (!doc.RootElement.TryGetProperty("detail", out var detail)) return null;
            if (detail.ValueKind != JsonValueKind.String) return null;
            var s = detail.GetString();
            return string.IsNullOrWhiteSpace(s) ? null : s;
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
