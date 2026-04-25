using System.Text.Json;
using System.Text.RegularExpressions;
using SharedCookbook.Domain.Entities;

namespace SharedCookbook.Api.Services;

/// <summary>
/// CFG-0 — central per-key validator for the <c>PUT /api/admin/extractor-
/// config/{key}</c> endpoint. Given a config key and the incoming JSON
/// value (raw <see cref="JsonElement"/> off the request body), returns
/// either the normalised JSON payload to persist or a validation error
/// with an English developer-facing message.
///
/// <para>
/// Rules are declared once in the <see cref="Validate"/> dispatch; neither
/// the endpoint nor the reset path re-implements any of the bounds
/// checks. This keeps the per-key contract in one auditable place
/// (/simplify review: the endpoint only orchestrates, the validator owns
/// the rules).
/// </para>
///
/// <para>
/// Security: every size/range cap is a defence-in-depth limit against an
/// Azure-cost-amplification attack where a compromised admin account
/// (or stolen token) tries to inflate prompts / max-tokens to absurd
/// values. Prompts are capped at 20 000 chars, <c>max_completion_tokens</c>
/// at 8192 (Azure's own hard ceiling for this deployment class), and the
/// string-list keys cap at 50 items × 100 chars each so a malformed
/// payload can't turn the <c>jsonb</c> column into a storage DoS vector.
/// </para>
/// </summary>
public sealed class ConfigKeyValidator
{
    /// <summary>
    /// CFG-0 — maximum length of an LLM system prompt. 20 000 chars is
    /// generous — today's prompts sit around 2-3 KB — while still
    /// preventing an attacker with admin credentials from pasting a
    /// multi-megabyte prompt the next extraction would then stream at
    /// Azure for as many tokens as it can afford.
    /// </summary>
    public const int MaxPromptChars = 20_000;

    /// <summary>Minimum prompt length — short enough that a one-liner
    /// emergency fallback fits, long enough that a fat-fingered
    /// "." won't accidentally neuter the extraction prompt.</summary>
    public const int MinPromptChars = 100;

    /// <summary>
    /// CFG-0 — hard ceiling on <c>max_completion_tokens</c>. 8192
    /// matches Azure's max for the gpt-4.1-mini / gpt-5.1-chat /
    /// gpt-4.1-mini-vision deployments; going higher either rejects
    /// server-side or silently caps. Cap here keeps the admin honest.
    /// </summary>
    public const int MaxCompletionTokens = 8192;

    /// <summary>Per-item length cap on <c>string_list</c> values
    /// (blacklists + shortener hosts). 100 chars is enough for any
    /// real hostname or label; the cap prevents a rogue entry
    /// turning the jsonb cell into a storage exploit.</summary>
    public const int StringListItemMaxLength = 100;

    /// <summary>Hard cap on the number of entries in a
    /// <c>string_list</c> value. 50 is ~5x the current largest list
    /// (<c>pipeline.shortener_hosts</c> with 8 items); the cap prevents
    /// an attacker from stuffing the jsonb column with thousands of
    /// entries.</summary>
    public const int StringListMaxItems = 50;

    /// <summary>Regex matching Azure deployment names. The cap comes
    /// from Azure's deployment-naming restrictions: lower-case letters,
    /// digits, dashes / dots / underscores, 2-64 chars, starting with
    /// a letter or digit.</summary>
    public static readonly Regex DeploymentNameRegex =
        new(@"^[a-z0-9][a-z0-9\-._]{1,63}$",
            RegexOptions.Compiled | RegexOptions.CultureInvariant);

    /// <summary>
    /// Validates + normalises an incoming JSON value for a config key.
    /// On success returns the canonical JSON text to persist (with any
    /// numeric coercion — e.g. integer <c>3</c> passed for a
    /// <c>float</c>-typed key — already applied so the Python consumer
    /// parses consistently).
    /// </summary>
    public ValidationResult Validate(string key, JsonElement value)
    {
        if (!ExtractorConfigDefaults.ByKey.TryGetValue(key, out var entry))
            return ValidationResult.Fail($"Unknown configuration key '{key}'.");

        return entry.ValueType switch
        {
            ExtractorConfigValueType.String => ValidateString(key, value),
            ExtractorConfigValueType.Int => ValidateInt(key, value),
            ExtractorConfigValueType.Float => ValidateFloat(key, value),
            ExtractorConfigValueType.Bool => ValidateBool(key, value),
            ExtractorConfigValueType.StringList => ValidateStringList(key, value),
            _ => ValidationResult.Fail(
                $"Unknown value type '{entry.ValueType}' for key '{key}'."),
        };
    }

    private ValidationResult ValidateString(string key, JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.String)
            return ValidationResult.Fail(
                $"Value for '{key}' must be a string.");
        var raw = value.GetString() ?? string.Empty;

        if (key.EndsWith(".system_prompt", StringComparison.Ordinal))
        {
            if (raw.Length < MinPromptChars)
                return ValidationResult.Fail(
                    $"System prompt must be at least {MinPromptChars} characters.");
            if (raw.Length > MaxPromptChars)
                return ValidationResult.Fail(
                    $"System prompt must be at most {MaxPromptChars} characters.");
        }
        else if (key.EndsWith(".deployment", StringComparison.Ordinal))
        {
            if (!DeploymentNameRegex.IsMatch(raw))
                return ValidationResult.Fail(
                    $"Deployment name '{raw}' is invalid. "
                    + "Allowed: lowercase letters, digits, '-', '_', '.', 2-64 characters.");
        }
        else
        {
            // Defensive catch-all for any future string-typed key we
            // add without a dedicated rule — cap at the prompt max so
            // a rogue value can't escape the length bound by picking a
            // key suffix the switch above doesn't recognise.
            if (raw.Length > MaxPromptChars)
                return ValidationResult.Fail(
                    $"Value for '{key}' must be at most {MaxPromptChars} characters.");
        }

        return ValidationResult.Ok(JsonSerializer.Serialize(raw));
    }

    private ValidationResult ValidateInt(string key, JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Number || !value.TryGetInt32(out var n))
            return ValidationResult.Fail(
                $"Value for '{key}' must be an integer.");

        var (min, max) = IntBounds(key);
        if (n < min || n > max)
            return ValidationResult.Fail(
                $"Value for '{key}' must be between {min} and {max}.");

        return ValidationResult.Ok(JsonSerializer.Serialize(n));
    }

    private ValidationResult ValidateFloat(string key, JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Number)
            return ValidationResult.Fail(
                $"Value for '{key}' must be a number.");
        if (!value.TryGetDouble(out var d) || double.IsNaN(d) || double.IsInfinity(d))
            return ValidationResult.Fail(
                $"Value for '{key}' must be a finite number.");

        var (min, max) = FloatBounds(key);
        if (d < min || d > max)
            return ValidationResult.Fail(
                $"Value for '{key}' must be between {min} and {max}.");

        // Round-trip through JSON so "0" → 0.0 → "0" stays stable
        // (System.Text.Json emits "0" for integer-valued doubles, which
        // is what we want in the ValueJson column).
        return ValidationResult.Ok(JsonSerializer.Serialize(d));
    }

    private ValidationResult ValidateBool(string key, JsonElement value)
    {
        if (value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            return ValidationResult.Fail(
                $"Value for '{key}' must be true or false.");
        return ValidationResult.Ok(value.GetBoolean() ? "true" : "false");
    }

    private ValidationResult ValidateStringList(string key, JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Array)
            return ValidationResult.Fail(
                $"Value for '{key}' must be a list of strings.");

        var items = new List<string>();
        foreach (var el in value.EnumerateArray())
        {
            if (el.ValueKind != JsonValueKind.String)
                return ValidationResult.Fail(
                    $"Entries in '{key}' must be strings.");
            var s = el.GetString() ?? string.Empty;
            if (string.IsNullOrWhiteSpace(s))
                return ValidationResult.Fail(
                    $"Entries in '{key}' must not be empty.");
            if (s.Length > StringListItemMaxLength)
                return ValidationResult.Fail(
                    $"Entries in '{key}' must be at most {StringListItemMaxLength} characters.");
            items.Add(s);
        }

        if (items.Count > StringListMaxItems)
            return ValidationResult.Fail(
                $"List '{key}' must contain at most {StringListMaxItems} entries.");

        return ValidationResult.Ok(JsonSerializer.Serialize(items));
    }

    private static (int min, int max) IntBounds(string key) => key switch
    {
        "llm.structured.max_completion_tokens" or
        "llm.chat.max_completion_tokens" or
        "llm.vision.max_completion_tokens" => (100, MaxCompletionTokens),
        "pipeline.min_transcript_chars" => (1, 10_000),
        "pipeline.component_label_max" => (1, 200),
        "pipeline.shortener_max_redirects" => (0, 10),
        _ => (0, int.MaxValue),
    };

    private static (double min, double max) FloatBounds(string key) => key switch
    {
        "llm.structured.temperature" or
        "llm.vision.temperature" => (0.0, 2.0),
        "pipeline.shortener_head_timeout_seconds" => (0.5, 30.0),
        _ => (double.MinValue, double.MaxValue),
    };

    /// <summary>Result of a single validation pass.</summary>
    public sealed record ValidationResult(bool IsValid, string? NormalizedJson, string? ErrorMessage)
    {
        public static ValidationResult Ok(string normalizedJson) =>
            new(true, normalizedJson, null);
        public static ValidationResult Fail(string errorMessage) =>
            new(false, null, errorMessage);
    }
}
