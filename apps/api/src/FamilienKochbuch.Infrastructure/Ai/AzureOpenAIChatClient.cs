using System.Net.Http.Headers;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace FamilienKochbuch.Infrastructure.Ai;

/// <summary>
/// CR2 — native .NET streaming client for the Azure OpenAI Chat
/// Completions API. Plain <see cref="HttpClient"/> (no SDK wrapper) so
/// we have full control over the SSE stream shape and the
/// <c>include_usage</c> envelope at end-of-stream.
///
/// Endpoint: <c>{endpoint}/openai/deployments/{deployment}/chat/completions?api-version=...</c>.
/// Headers: <c>api-key: {apiKey}</c> (Azure-specific, not a Bearer token).
/// Body: <c>{ messages, stream: true, stream_options: { include_usage: true }, max_tokens, temperature }</c>.
///
/// The streaming method returns an <see cref="IAsyncEnumerable{ChatStreamChunk}"/>
/// that yields:
/// <list type="bullet">
/// <item><see cref="ChatStreamChunk.Token"/> per delta received
/// (<c>choices[0].delta.content</c>)</item>
/// <item><see cref="ChatStreamChunk.Usage"/> exactly once (Azure's
/// final <c>usage</c> chunk)</item>
/// <item><see cref="ChatStreamChunk.Error"/> on any transport or parse
/// failure (terminates the enumerable; the endpoint persists whatever
/// has been streamed so far).</item>
/// </list>
///
/// Secrets: the API key is read via <see cref="IOptions{T}"/> and only
/// ever attached as the <c>api-key</c> request header. Logs never
/// include the key, the endpoint, or user content — only counts,
/// durations, and the deployment name.
/// </summary>
public sealed class AzureOpenAIChatClient : IAzureOpenAIChatClient
{
    public const string HttpClientName = "AzureOpenAI";

    private readonly HttpClient _http;
    private readonly AzureOpenAIOptions _options;
    private readonly ILogger<AzureOpenAIChatClient> _logger;

    public AzureOpenAIChatClient(
        HttpClient http,
        IOptions<AzureOpenAIOptions> options,
        ILogger<AzureOpenAIChatClient> logger)
    {
        _http = http;
        _options = options.Value;
        _logger = logger;
    }

    /// <inheritdoc />
    public async IAsyncEnumerable<ChatStreamChunk> StreamAsync(
        IReadOnlyList<ChatCompletionMessage> messages,
        [EnumeratorCancellation] CancellationToken ct)
    {
        if (!TryBuildRequest(messages, stream: true, out var request, out var config))
        {
            yield return new ChatStreamChunk.Error(
                "chat_not_configured",
                "Azure OpenAI ist nicht konfiguriert.");
            yield break;
        }

        HttpResponseMessage? response = null;
        Stream? stream = null;
        StreamReader? reader = null;
        ChatStreamChunk.Error? fatalError = null;
        try
        {
            try
            {
                response = await _http.SendAsync(
                    request, HttpCompletionOption.ResponseHeadersRead, ct)
                    .ConfigureAwait(false);
            }
            catch (HttpRequestException ex)
            {
                _logger.LogWarning(ex,
                    "Azure OpenAI transport error deployment={Deployment}",
                    config.Deployment);
                fatalError = new ChatStreamChunk.Error(
                    "azure_unavailable",
                    "Der KI-Dienst ist derzeit nicht erreichbar.");
            }
            catch (TaskCanceledException ex) when (!ct.IsCancellationRequested)
            {
                _logger.LogWarning(ex,
                    "Azure OpenAI timeout deployment={Deployment}",
                    config.Deployment);
                fatalError = new ChatStreamChunk.Error(
                    "azure_timeout",
                    "Der KI-Dienst hat zu lange gebraucht.");
            }

            if (fatalError is not null)
            {
                yield return fatalError;
                yield break;
            }

            if (response is null)
            {
                // Defensive — should be unreachable; helps the null-flow
                // analyzer see that the response is non-null below.
                yield return new ChatStreamChunk.Error(
                    "azure_unavailable",
                    "Der KI-Dienst ist derzeit nicht erreichbar.");
                yield break;
            }

            if (!response.IsSuccessStatusCode)
            {
                _logger.LogWarning(
                    "Azure OpenAI non-success status={Status} deployment={Deployment}",
                    (int)response.StatusCode, config.Deployment);
                yield return new ChatStreamChunk.Error(
                    "azure_error",
                    "Der KI-Dienst hat einen Fehler gemeldet.");
                yield break;
            }

            stream = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            reader = new StreamReader(stream, Encoding.UTF8);
        }
        finally
        {
            if (reader is null && stream is not null)
                await stream.DisposeAsync().ConfigureAwait(false);
            if (reader is null)
                request.Dispose();
        }

        // Hand-rolled reader to keep the control flow explicit; helps
        // the compiler understand the async-iterator state machine.
        try
        {
            await foreach (var chunk in ParseSseAsync(reader!, ct).ConfigureAwait(false))
                yield return chunk;
        }
        finally
        {
            reader?.Dispose();
            response?.Dispose();
            request.Dispose();
        }
    }

    /// <inheritdoc />
    public async Task<string> CompleteAsync(
        IReadOnlyList<ChatCompletionMessage> messages,
        CancellationToken ct)
    {
        if (!TryBuildRequest(messages, stream: false, out var request, out var config))
            throw new InvalidOperationException("Azure OpenAI ist nicht konfiguriert.");

        using (request)
        {
            using var response = await _http.SendAsync(request, ct).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                _logger.LogWarning(
                    "Azure OpenAI title-complete non-success status={Status} deployment={Deployment}",
                    (int)response.StatusCode, config.Deployment);
                throw new HttpRequestException(
                    $"Azure OpenAI returned {(int)response.StatusCode}");
            }

            var body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            if (root.TryGetProperty("choices", out var choices)
                && choices.ValueKind == JsonValueKind.Array
                && choices.GetArrayLength() > 0)
            {
                var first = choices[0];
                if (first.TryGetProperty("message", out var message)
                    && message.TryGetProperty("content", out var content)
                    && content.ValueKind == JsonValueKind.String)
                {
                    return content.GetString() ?? string.Empty;
                }
            }
            return string.Empty;
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────

    private sealed record RequestConfig(string Endpoint, string ApiVersion, string Deployment);

    private bool TryBuildRequest(
        IReadOnlyList<ChatCompletionMessage> messages,
        bool stream,
        out HttpRequestMessage request,
        out RequestConfig config)
    {
        var endpoint = _options.Endpoint?.TrimEnd('/') ?? string.Empty;
        var apiKey = _options.ApiKey ?? string.Empty;
        var apiVersion = _options.ApiVersion ?? string.Empty;
        var deployment = _options.ResolveChatDeployment();
        config = new RequestConfig(endpoint, apiVersion, deployment);

        request = null!;
        if (string.IsNullOrWhiteSpace(endpoint)
            || string.IsNullOrWhiteSpace(apiKey)
            || string.IsNullOrWhiteSpace(apiVersion)
            || string.IsNullOrWhiteSpace(deployment))
        {
            return false;
        }

        var uri = $"{endpoint}/openai/deployments/{Uri.EscapeDataString(deployment)}"
                  + $"/chat/completions?api-version={Uri.EscapeDataString(apiVersion)}";

        var payload = new Dictionary<string, object?>
        {
            ["messages"] = messages.Select(m => new { role = m.Role, content = m.Content }).ToArray(),
            ["max_tokens"] = 2048,
            ["temperature"] = 0.7,
        };
        if (stream)
        {
            payload["stream"] = true;
            payload["stream_options"] = new { include_usage = true };
        }

        var json = JsonSerializer.SerializeToUtf8Bytes(payload);
        request = new HttpRequestMessage(HttpMethod.Post, uri)
        {
            Content = new ByteArrayContent(json),
        };
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json") { CharSet = "utf-8" };
        request.Headers.TryAddWithoutValidation("api-key", apiKey);
        return true;
    }

    /// <summary>
    /// Parse Azure's SSE stream line-by-line. Each event is a
    /// <c>data: {json}</c> line followed by a blank; the terminal
    /// sentinel is <c>data: [DONE]</c>. Malformed lines are skipped —
    /// Azure sometimes interleaves keep-alive comments.
    /// </summary>
    private async IAsyncEnumerable<ChatStreamChunk> ParseSseAsync(
        StreamReader reader,
        [EnumeratorCancellation] CancellationToken ct)
    {
        while (true)
        {
            var (line, readError) = await SafeReadLineAsync(reader, ct).ConfigureAwait(false);
            if (readError is not null)
            {
                yield return readError;
                yield break;
            }

            if (line is null) yield break;
            if (line.Length == 0) continue;
            if (!line.StartsWith("data:", StringComparison.Ordinal)) continue;

            var payload = line.AsSpan(5).TrimStart().ToString();
            if (payload.Length == 0) continue;
            if (payload == "[DONE]") yield break;

            ChatStreamChunk? chunk;
            try
            {
                chunk = ParseChunk(payload);
            }
            catch (JsonException ex)
            {
                _logger.LogDebug(ex, "Skipping unparseable SSE chunk");
                chunk = null;
            }
            if (chunk is not null) yield return chunk;
        }
    }

    /// <summary>
    /// Read one line from the stream, translating cancellation into a
    /// clean EOF and IO errors into an Error chunk. Split from
    /// <see cref="ParseSseAsync"/> because C# forbids <c>yield return</c>
    /// inside <c>catch</c> blocks.
    /// </summary>
    private async Task<(string? Line, ChatStreamChunk.Error? Error)> SafeReadLineAsync(
        StreamReader reader, CancellationToken ct)
    {
        try
        {
            return (await reader.ReadLineAsync(ct).ConfigureAwait(false), null);
        }
        catch (OperationCanceledException)
        {
            return (null, null);
        }
        catch (IOException ex)
        {
            _logger.LogWarning(ex, "Azure OpenAI stream IO error");
            return (null, new ChatStreamChunk.Error(
                "azure_stream_broken",
                "Die Verbindung zum KI-Dienst ist abgebrochen."));
        }
    }

    /// <summary>
    /// Parse a single Azure chat-completions chunk into either a Token
    /// (delta.content), a Usage (final usage envelope), or null
    /// (role-only / empty-delta chunk — skipped by the caller).
    /// </summary>
    internal static ChatStreamChunk? ParseChunk(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        // Azure emits the final usage envelope as a chunk with an empty
        // choices array + a populated usage field.
        if (root.TryGetProperty("usage", out var usage)
            && usage.ValueKind == JsonValueKind.Object)
        {
            var prompt = TryGetInt(usage, "prompt_tokens");
            var completion = TryGetInt(usage, "completion_tokens");
            var cached = 0;
            if (usage.TryGetProperty("prompt_tokens_details", out var details)
                && details.ValueKind == JsonValueKind.Object)
            {
                cached = TryGetInt(details, "cached_tokens");
            }
            if (cached > prompt) cached = prompt;
            if (prompt > 0 || completion > 0 || cached > 0)
                return new ChatStreamChunk.Usage(prompt, completion, cached);
        }

        if (!root.TryGetProperty("choices", out var choices)
            || choices.ValueKind != JsonValueKind.Array
            || choices.GetArrayLength() == 0)
        {
            return null;
        }

        var choice = choices[0];
        if (!choice.TryGetProperty("delta", out var delta)
            || delta.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        if (!delta.TryGetProperty("content", out var content)
            || content.ValueKind != JsonValueKind.String)
        {
            return null;
        }

        var text = content.GetString();
        if (string.IsNullOrEmpty(text)) return null;
        return new ChatStreamChunk.Token(text);
    }

    private static int TryGetInt(JsonElement element, string name)
    {
        if (!element.TryGetProperty(name, out var prop)) return 0;
        return prop.ValueKind switch
        {
            JsonValueKind.Number when prop.TryGetInt32(out var n) && n >= 0 => n,
            _ => 0,
        };
    }
}
