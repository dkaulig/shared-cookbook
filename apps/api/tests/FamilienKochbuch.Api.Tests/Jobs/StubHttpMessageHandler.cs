using System.Net;

namespace FamilienKochbuch.Api.Tests.Jobs;

/// <summary>
/// Test double for <see cref="HttpMessageHandler"/> — captures every
/// outgoing request, and replays the scripted responses in order.
/// Used by the extraction-job tests to simulate the Python service
/// without spinning up a real socket.
///
/// Scripting is deliberately simple: push responses into
/// <see cref="QueueResponse"/> in the order they should be returned.
/// Exhausting the queue on a pending request surfaces as a test
/// failure via <see cref="InvalidOperationException"/>.
/// </summary>
internal sealed class StubHttpMessageHandler : HttpMessageHandler
{
    private readonly Queue<Func<HttpRequestMessage, HttpResponseMessage>> _responders = new();

    public List<CapturedRequest> Requests { get; } = new();

    public readonly record struct CapturedRequest(
        HttpMethod Method,
        Uri Uri,
        string? Body,
        IReadOnlyDictionary<string, string> Headers);

    public void QueueResponse(HttpStatusCode status, string? body, string contentType = "application/json")
    {
        _responders.Enqueue(_ =>
        {
            var resp = new HttpResponseMessage(status);
            if (body is not null)
                resp.Content = new StringContent(body, System.Text.Encoding.UTF8, contentType);
            return resp;
        });
    }

    /// <summary>PF2 helper: enqueue a 200 response carrying the four
    /// <c>X-Extractor-*</c> token-usage headers the .NET side reads in
    /// extraction-job tests and chat-endpoint tests.</summary>
    public void QueueResponseWithUsage(
        HttpStatusCode status,
        string? body,
        int promptTokens,
        int completionTokens,
        int cachedPromptTokens,
        string model,
        string contentType = "application/json")
    {
        _responders.Enqueue(_ =>
        {
            var resp = new HttpResponseMessage(status);
            if (body is not null)
                resp.Content = new StringContent(body, System.Text.Encoding.UTF8, contentType);
            resp.Headers.Add("X-Extractor-Prompt-Tokens", promptTokens.ToString());
            resp.Headers.Add("X-Extractor-Completion-Tokens", completionTokens.ToString());
            resp.Headers.Add("X-Extractor-Cached-Tokens", cachedPromptTokens.ToString());
            resp.Headers.Add("X-Extractor-Model", model);
            return resp;
        });
    }

    public void QueueResponder(Func<HttpRequestMessage, HttpResponseMessage> responder)
    {
        _responders.Enqueue(responder);
    }

    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
    {
        string? body = null;
        if (request.Content is not null)
            body = await request.Content.ReadAsStringAsync(cancellationToken);
        var headers = request.Headers.ToDictionary(
            h => h.Key,
            h => string.Join(",", h.Value),
            StringComparer.OrdinalIgnoreCase);
        Requests.Add(new CapturedRequest(request.Method, request.RequestUri!, body, headers));

        if (!_responders.TryDequeue(out var responder))
            throw new InvalidOperationException(
                $"No scripted response for {request.Method} {request.RequestUri}.");
        return responder(request);
    }
}

/// <summary>
/// Minimal <see cref="IHttpClientFactory"/> that returns HttpClients
/// wrapping the <see cref="StubHttpMessageHandler"/> under the expected
/// named-client name. Configures a BaseAddress so the jobs can dispatch
/// to relative URLs ("/extract/url") in the same shape as production.
/// </summary>
internal sealed class StubHttpClientFactory : IHttpClientFactory
{
    private readonly StubHttpMessageHandler _handler;
    private readonly Uri _baseAddress;

    public StubHttpClientFactory(StubHttpMessageHandler handler, Uri baseAddress)
    {
        _handler = handler;
        _baseAddress = baseAddress;
    }

    public HttpClient CreateClient(string name) => new(_handler, disposeHandler: false)
    {
        BaseAddress = _baseAddress,
    };
}
