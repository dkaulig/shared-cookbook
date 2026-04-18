using System.Net.Http.Json;
using System.Text.Json;
using FamilienKochbuch.Api.Services;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace FamilienKochbuch.Api.Tests.Endpoints;

/// <summary>
/// Unit tests for the global exception handler. Hitting the handler
/// directly (instead of through a test host) keeps the assertion tight
/// to the wire-shape guarantee — every thrown exception must produce
/// a JSON <see cref="ErrorResponse"/> with status 500.
/// </summary>
public class GlobalExceptionHandlerTests
{
    [Fact]
    public async Task Handler_Writes_500_With_Uniform_ErrorResponse_Body()
    {
        var ctx = BuildContext(new InvalidOperationException("boom for test"));

        var handler = new GlobalExceptionHandler(NullLogger<GlobalExceptionHandler>.Instance);
        var handled = await handler.TryHandleAsync(ctx,
            ctx.Features.Get<IExceptionHandlerFeature>()!.Error, CancellationToken.None);

        Assert.True(handled);
        Assert.Equal(StatusCodes.Status500InternalServerError, ctx.Response.StatusCode);
        Assert.StartsWith("application/json", ctx.Response.ContentType);

        ctx.Response.Body.Position = 0;
        using var doc = await JsonDocument.ParseAsync(ctx.Response.Body);
        var root = doc.RootElement;
        Assert.Equal("internal_error", root.GetProperty("code").GetString());
        Assert.False(string.IsNullOrWhiteSpace(root.GetProperty("message").GetString()));
    }

    [Fact]
    public async Task Handler_Does_Not_Leak_Exception_Message_To_Client()
    {
        var secret = "exception-message-we-do-not-want-to-leak";
        var ctx = BuildContext(new InvalidOperationException(secret));

        var handler = new GlobalExceptionHandler(NullLogger<GlobalExceptionHandler>.Instance);
        await handler.TryHandleAsync(ctx,
            ctx.Features.Get<IExceptionHandlerFeature>()!.Error, CancellationToken.None);

        ctx.Response.Body.Position = 0;
        using var reader = new StreamReader(ctx.Response.Body);
        var body = await reader.ReadToEndAsync();

        Assert.DoesNotContain(secret, body, StringComparison.Ordinal);
    }

    private static DefaultHttpContext BuildContext(Exception ex)
    {
        var services = new ServiceCollection()
            .AddLogging()
            .AddSingleton<GlobalExceptionHandler>()
            .AddSingleton(NullLoggerFactory.Instance)
            .BuildServiceProvider();

        var ctx = new DefaultHttpContext
        {
            RequestServices = services,
        };
        ctx.Response.Body = new MemoryStream();
        ctx.Features.Set<IExceptionHandlerFeature>(new ExceptionHandlerFeatureStub(ex));
        return ctx;
    }

    private sealed class ExceptionHandlerFeatureStub(Exception error) : IExceptionHandlerFeature
    {
        public Exception Error { get; } = error;
        public string Path => "/api/test";
        public Microsoft.AspNetCore.Http.Endpoint? Endpoint => null;
        public Microsoft.AspNetCore.Routing.RouteValueDictionary? RouteValues => null;
    }
}
