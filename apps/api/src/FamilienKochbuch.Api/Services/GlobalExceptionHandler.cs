using System.Text.Json;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace FamilienKochbuch.Api.Services;

/// <summary>
/// Global exception handler — catches unhandled exceptions that bubble
/// up past the endpoint handlers and converts them into a uniform
/// <see cref="ErrorResponse"/> JSON body with status 500. Never echoes
/// the exception message to the wire (message leaks may expose stack
/// frames or PII); the full exception is logged server-side instead.
/// </summary>
public sealed class GlobalExceptionHandler(ILogger<GlobalExceptionHandler> logger) : IExceptionHandler
{
    private const string Code = "internal_error";
    private const string Message = "Es ist ein unerwarteter Fehler aufgetreten. Bitte versuche es später erneut.";

    public async ValueTask<bool> TryHandleAsync(
        HttpContext httpContext,
        Exception exception,
        CancellationToken cancellationToken)
    {
        logger.LogError(exception, "Unhandled exception on {Path}", httpContext.Request.Path);

        httpContext.Response.StatusCode = StatusCodes.Status500InternalServerError;
        httpContext.Response.ContentType = "application/json; charset=utf-8";

        var body = new ErrorResponse(Code, Message);
        await JsonSerializer.SerializeAsync(httpContext.Response.Body, body,
            FamilienResults.JsonOptions, cancellationToken);
        return true;
    }
}
