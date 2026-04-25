namespace SharedCookbook.Api.Services;

/// <summary>
/// REL-7 — strongly-typed view of the "is AI available?" switches that
/// drive the <c>GET /api/meta/features</c> endpoint (and therefore the
/// frontend feature-gate that hides Import-from-Photo / Chat / etc.
/// when the operator chose to run without AI).
///
/// The flags mirror the Python extractor's <c>AI_ENABLED</c> +
/// <c>LLM_PROVIDER</c> env vars by design — operators set both in a
/// single <c>.env</c> file and docker-compose forwards them to both
/// containers. Keeping the names identical means there's exactly one
/// mental model for "how do I turn AI off".
///
/// Binding section: <c>Ai</c> (e.g. <c>Ai__Enabled=true</c>,
/// <c>Ai__Provider=ollama</c>). Docker-compose maps the top-level
/// <c>AI_ENABLED</c> + <c>LLM_PROVIDER</c> env vars onto these via the
/// existing "Ai__XXX → Ai:XXX" convention.
/// </summary>
public sealed class AiFeatureOptions
{
    public const string SectionName = "Ai";

    /// <summary>Master switch. Default <c>false</c> so a fresh install
    /// boots without AI — operators explicitly opt in by setting
    /// <c>AI_ENABLED=true</c> in their <c>.env</c>.</summary>
    public bool Enabled { get; set; }

    /// <summary>Chosen backend. Recognised values (case-insensitive):
    /// <c>azure</c>, <c>ollama</c>, <c>disabled</c>. Any other string
    /// is treated as <c>disabled</c> — operators see the AI off state
    /// until they fix the typo.</summary>
    public string Provider { get; set; } = "disabled";

    /// <summary>Normalise <see cref="Provider"/> to one of the three
    /// recognised literals so downstream code doesn't need to
    /// re-validate. Returns <c>null</c> when AI is off (either via
    /// <see cref="Enabled"/> or <see cref="Provider"/> ==
    /// <c>disabled</c>).</summary>
    public string? ResolveProvider()
    {
        if (!Enabled) return null;
        return Provider?.Trim().ToLowerInvariant() switch
        {
            "azure" => "azure",
            "ollama" => "ollama",
            _ => null,
        };
    }
}
