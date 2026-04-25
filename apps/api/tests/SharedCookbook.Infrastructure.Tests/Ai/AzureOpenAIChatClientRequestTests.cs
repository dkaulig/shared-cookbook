using System.Net.Http;
using System.Text;
using System.Text.Json;
using SharedCookbook.Infrastructure.Ai;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;

namespace SharedCookbook.Infrastructure.Tests.Ai;

/// <summary>
/// 2026-04-21 — Azure's GPT-5.x-chat deployments (2025-04-01-preview
/// and later) reject <c>max_tokens</c> as unsupported parameter and
/// require <c>max_completion_tokens</c> instead. They also reject any
/// non-default <c>temperature</c>. These tests guard the payload shape
/// so a regression to the old parameter names silently breaks chat
/// again.
/// </summary>
public class AzureOpenAIChatClientRequestTests
{
    private static AzureOpenAIChatClient BuildClient()
    {
        var http = new HttpClient { BaseAddress = new Uri("https://unused.invalid/") };
        var options = Options.Create(new AzureOpenAIOptions
        {
            Endpoint = "https://example.openai.azure.com",
            ApiKey = "key",
            ApiVersion = "2025-04-01-preview",
            ChatDeployment = "gpt-5.1-chat",
        });
        var logger = NullLogger<AzureOpenAIChatClient>.Instance;
        return new AzureOpenAIChatClient(http, options, logger);
    }

    private static async Task<JsonDocument> ReadBodyAsync(HttpRequestMessage request)
    {
        Assert.NotNull(request.Content);
        var bytes = await request.Content!.ReadAsByteArrayAsync();
        return JsonDocument.Parse(Encoding.UTF8.GetString(bytes));
    }

    [Fact]
    public async Task TryBuildRequest_Uses_max_completion_tokens_Not_max_tokens()
    {
        var client = BuildClient();
        var messages = new[] { new ChatCompletionMessage("user", "hi") };

        var ok = client.TryBuildRequest(messages, stream: true, out var request, out _);

        Assert.True(ok);
        using var doc = await ReadBodyAsync(request);
        var root = doc.RootElement;
        Assert.True(root.TryGetProperty("max_completion_tokens", out var cap));
        Assert.Equal(2048, cap.GetInt32());
        Assert.False(root.TryGetProperty("max_tokens", out _));
    }

    [Fact]
    public async Task TryBuildRequest_Does_Not_Send_Temperature()
    {
        var client = BuildClient();
        var messages = new[] { new ChatCompletionMessage("user", "hi") };

        var ok = client.TryBuildRequest(messages, stream: false, out var request, out _);

        Assert.True(ok);
        using var doc = await ReadBodyAsync(request);
        // Azure's GPT-5.x chat deployments reject non-default
        // temperature values with an `unsupported_value` 400. Keep it
        // out of the payload entirely.
        Assert.False(doc.RootElement.TryGetProperty("temperature", out _));
    }
}
