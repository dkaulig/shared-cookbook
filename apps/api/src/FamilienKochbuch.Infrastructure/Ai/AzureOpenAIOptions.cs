namespace FamilienKochbuch.Infrastructure.Ai;

/// <summary>
/// CR2 — strongly-typed settings for the native-.NET Azure OpenAI
/// streaming chat client.
///
/// The Python extractor already consumes the four Azure env vars
/// (endpoint / api-key / api-version / deployment). We bind the same
/// pair on the .NET side via <c>AzureOpenAI__*</c> keys and additionally
/// allow an optional <see cref="ChatDeployment"/> override — today the
/// chat model == the extraction model, so when
/// <see cref="ChatDeployment"/> is blank the runtime falls back to
/// <see cref="Deployment"/>. One set of secrets, two call-sites.
///
/// The API key is a secret and MUST be read through <c>IOptions&lt;T&gt;</c>
/// — never logged, never echoed in error messages. The chat client adds
/// it as the <c>api-key</c> request header and that is the only place it
/// appears in outgoing traffic.
/// </summary>
public sealed class AzureOpenAIOptions
{
    public const string SectionName = "AzureOpenAI";

    /// <summary>Resource root, e.g. <c>https://resource.openai.azure.com</c>.
    /// No trailing slash — the chat client normalises.</summary>
    public string Endpoint { get; set; } = string.Empty;

    /// <summary>Azure subscription key. Sent as the <c>api-key</c>
    /// header on every request. Secret.</summary>
    public string ApiKey { get; set; } = string.Empty;

    /// <summary>Pinned API version, e.g. <c>2025-04-01-preview</c>.</summary>
    public string ApiVersion { get; set; } = string.Empty;

    /// <summary>Chat-completions deployment name. Falls back to
    /// <see cref="Deployment"/> when blank so a single-deployment
    /// Azure resource (the current prod shape) Just Works.</summary>
    public string ChatDeployment { get; set; } = string.Empty;

    /// <summary>Legacy single-deployment env var name; reused as the
    /// fallback for <see cref="ChatDeployment"/>. Mirrors the Python
    /// side's <c>AZURE_OPENAI_DEPLOYMENT_CHAT</c> +
    /// <c>AZURE_OPENAI_DEPLOYMENT_STRUCTURING</c> pair.</summary>
    public string Deployment { get; set; } = string.Empty;

    /// <summary>Resolve the effective chat deployment: prefer
    /// <see cref="ChatDeployment"/>, fall back to <see cref="Deployment"/>.
    /// Empty string when neither is set so the chat client can raise a
    /// single clean error.</summary>
    public string ResolveChatDeployment() =>
        !string.IsNullOrWhiteSpace(ChatDeployment)
            ? ChatDeployment
            : Deployment;
}
