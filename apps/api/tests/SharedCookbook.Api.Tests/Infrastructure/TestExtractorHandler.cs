using System.Net;

namespace SharedCookbook.Api.Tests.Infrastructure;

/// <summary>
/// In-memory <see cref="HttpMessageHandler"/> the WebApplicationFactory
/// wires under the named "python-extractor" client. P2-6 endpoint tests
/// script responses with <see cref="QueueResponse"/> (or
/// <see cref="QueueResponder"/> for dynamic behaviour) and inspect the
/// captured request shape via <see cref="Requests"/>.
///
/// The handler is shared per-factory instance and kept alive across
/// every test in the class fixture — each test should call
/// <see cref="Reset"/> in its setup to avoid replay bleed between
/// cases.
/// </summary>
public sealed class TestExtractorHandler : HttpMessageHandler
{
    private readonly Queue<Func<HttpRequestMessage, HttpResponseMessage>> _responders = new();
    private readonly List<CapturedRequest> _requests = new();
    private readonly object _gate = new();

    public IReadOnlyList<CapturedRequest> Requests
    {
        get
        {
            lock (_gate) return _requests.ToArray();
        }
    }

    public readonly record struct CapturedRequest(
        HttpMethod Method,
        Uri Uri,
        string? Body,
        IReadOnlyDictionary<string, string> Headers);

    public void QueueResponse(HttpStatusCode status, string? body, string contentType = "application/json")
    {
        lock (_gate)
        {
            _responders.Enqueue(_ =>
            {
                var resp = new HttpResponseMessage(status);
                if (body is not null)
                    resp.Content = new StringContent(body, System.Text.Encoding.UTF8, contentType);
                return resp;
            });
        }
    }

    /// <summary>PF2 helper: enqueue a 200 response carrying the four
    /// <c>X-Extractor-*</c> token-usage headers the .NET side reads
    /// off every successful Python response.</summary>
    public void QueueResponseWithUsage(
        HttpStatusCode status,
        string? body,
        int promptTokens,
        int completionTokens,
        int cachedPromptTokens,
        string model,
        string contentType = "application/json")
    {
        lock (_gate)
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
    }

    public void QueueResponder(Func<HttpRequestMessage, HttpResponseMessage> responder)
    {
        lock (_gate) _responders.Enqueue(responder);
    }

    public void Reset()
    {
        lock (_gate)
        {
            _responders.Clear();
            _requests.Clear();
        }
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

        Func<HttpRequestMessage, HttpResponseMessage>? responder;
        lock (_gate)
        {
            _requests.Add(new CapturedRequest(
                request.Method, request.RequestUri!, body, headers));
            if (!_responders.TryDequeue(out responder))
                throw new InvalidOperationException(
                    $"No scripted response for {request.Method} {request.RequestUri}.");
        }
        return responder!(request);
    }
}
