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
public static class UsageHeaders
{
    public const string PromptTokensHeader = "X-Extractor-Prompt-Tokens";
    public const string CompletionTokensHeader = "X-Extractor-Completion-Tokens";
    public const string CachedTokensHeader = "X-Extractor-Cached-Tokens";
    public const string ModelHeader = "X-Extractor-Model";

    /// <summary>
    /// Attempt to parse all four token-usage headers off a Python
    /// response. Any missing / malformed header yields <c>false</c> —
    /// the caller skips persisting usage and the row stays with NULL
    /// columns. We deliberately don't fail the job on bad headers
    /// because the extraction itself succeeded; the headers are
    /// telemetry.
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

        modelDeployment = model;
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
