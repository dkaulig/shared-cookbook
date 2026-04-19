using System.Text.RegularExpressions;

namespace FamilienKochbuch.Api.Services;

/// <summary>
/// Parser for the four <c>X-Extractor-*</c> response headers the Python
/// extractor emits on every successful LLM call (PF2 telemetry).
///
/// Header names must match the constants on the Python side
/// (<c>extractor/main.py</c>). Changing either without the other is a
/// breaking contract bug.
///
/// Callers: <see cref="PythonExtractorRunner"/> (persists the numbers
/// on a <see cref="Domain.Entities.RecipeImport"/>) and the chat proxy
/// endpoint (persists a <see cref="Domain.Entities.ChatUsageLog"/>).
/// </summary>
public static partial class UsageHeaders
{
    public const string PromptTokensHeader = "X-Extractor-Prompt-Tokens";
    public const string CompletionTokensHeader = "X-Extractor-Completion-Tokens";
    public const string CachedTokensHeader = "X-Extractor-Cached-Tokens";
    public const string ModelHeader = "X-Extractor-Model";

    /// <summary>Sentinel string persisted when the Python service sends
    /// a malformed / oversized / control-char-laden model deployment
    /// name. Keeps the telemetry row intact while preventing bucket
    /// spoofing in the admin KI-usage dashboard.</summary>
    public const string UnknownModelSentinel = "(unknown)";

    // Defence in depth against a misconfigured / hostile Python service
    // emitting a garbage deployment name that could spoof another model
    // bucket in the admin dashboard (security-review Vuln 1, conf 5).
    // Azure deployment names are [A-Za-z0-9._-] and short; 64 chars is
    // generous. Anything outside gets collapsed to the sentinel.
    [GeneratedRegex(@"^[A-Za-z0-9._-]{1,64}$")]
    private static partial Regex ModelDeploymentPattern();

    /// <summary>
    /// Attempt to parse all four token-usage headers off a Python
    /// response. Any missing / malformed numeric header yields
    /// <c>false</c> — the caller skips persisting usage and the row
    /// stays with NULL columns. A model-deployment string that fails
    /// the allowlist is replaced with <see cref="UnknownModelSentinel"/>
    /// but does NOT fail the read: telemetry with an anonymised
    /// bucket is better than dropping the counters on the floor.
    /// </summary>
    public static bool TryRead(
        HttpResponseMessage response,
        out int promptTokens,
        out int completionTokens,
        out int cachedPromptTokens,
        out string modelDeployment)
    {
        promptTokens = 0;
        completionTokens = 0;
        cachedPromptTokens = 0;
        modelDeployment = string.Empty;

        if (!TryParseIntHeader(response, PromptTokensHeader, out promptTokens)) return false;
        if (!TryParseIntHeader(response, CompletionTokensHeader, out completionTokens)) return false;
        if (!TryParseIntHeader(response, CachedTokensHeader, out cachedPromptTokens)) return false;
        if (!response.Headers.TryGetValues(ModelHeader, out var modelValues)) return false;

        var model = modelValues?.FirstOrDefault();
        if (string.IsNullOrWhiteSpace(model)) return false;
        if (promptTokens < 0 || completionTokens < 0 || cachedPromptTokens < 0) return false;
        // Same invariant RecordUsage enforces — guard here so the
        // domain throw never fires on telemetry.
        if (cachedPromptTokens > promptTokens) return false;

        modelDeployment = ModelDeploymentPattern().IsMatch(model) ? model : UnknownModelSentinel;
        return true;
    }

    private static bool TryParseIntHeader(HttpResponseMessage response, string name, out int value)
    {
        value = 0;
        if (!response.Headers.TryGetValues(name, out var values)) return false;
        var raw = values?.FirstOrDefault();
        return int.TryParse(raw, out value);
    }
}
