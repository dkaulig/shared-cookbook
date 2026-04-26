using System.Text.Json;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using SharedCookbook.Infrastructure.Services;

namespace SharedCookbook.Api.Services;

/// <summary>
/// Global exception handler — catches unhandled exceptions that bubble
/// up past the endpoint handlers and converts them into a uniform
/// <see cref="ErrorResponse"/> JSON body with status 500. Never echoes
/// the exception message to the wire (message leaks may expose stack
/// frames or PII); the full exception is logged server-side instead.
/// </summary>
public sealed class GlobalExceptionHandler(ILogger<GlobalExceptionHandler> logger) : IExceptionHandler
{
    private const string Message = "An unexpected error occurred. Please retry later.";

    public async ValueTask<bool> TryHandleAsync(
        HttpContext httpContext,
        Exception exception,
        CancellationToken cancellationToken)
    {
        // SEC-1: sanitize the user-influenced path before logging to
        // mitigate CRLF / log-forging where a crafted URL with embedded
        // \r\n could fabricate adjacent log lines.
        logger.LogError(exception, "Unhandled exception on {Path}",
            LogSanitizer.ForLog(httpContext.Request.Path.Value));

        httpContext.Response.StatusCode = StatusCodes.Status500InternalServerError;
        httpContext.Response.ContentType = "application/json; charset=utf-8";

        var body = new ErrorResponse(
            ErrorCodes.InternalError,
            Message,
            StatusCodes.Status500InternalServerError);
        await JsonSerializer.SerializeAsync(httpContext.Response.Body, body,
            FamilienResults.JsonOptions, cancellationToken);
        return true;
    }
}
