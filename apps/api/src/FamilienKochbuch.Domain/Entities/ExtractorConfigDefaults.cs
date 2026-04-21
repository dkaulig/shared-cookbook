using System.Collections.Generic;
using System.Linq;

namespace FamilienKochbuch.Domain.Entities;

/// <summary>
/// CFG-0 — the single source of truth for the hot-configurable
/// extractor-knob registry. Each <see cref="Entry"/> carries the dotted
/// <see cref="Entry.Key"/> plus the JSON-encoded default value the
/// <c>AddExtractorConfig</c> migration seeds into the DB on first boot
/// and the <c>POST /api/admin/extractor-config/{key}/reset</c> endpoint
/// reverts to on demand.
///
/// <para>
/// The values hardcoded here intentionally mirror the python-extractor
/// defaults as of v0.11.0 (see <c>apps/python-extractor/src/extractor/
/// pipeline/url.py</c>, <c>post_process.py</c>,
/// <c>prompts/recipe_extraction.py</c>, <c>prompts/chat.py</c>,
/// <c>llm/azure_openai.py</c>). Turning CFG on at boot is a no-op —
/// the DB values already match the Python constants — so the only
/// drift risk is a future Python tweak landing without an accompanying
/// migration to update the default here. The design doc calls that
/// out: Python-defaults are the "ground truth", DB values OVERRIDE.
/// </para>
///
/// <para>
/// <b>Prompt placeholders.</b> For the three <c>*.system_prompt</c>
/// keys the default here is a short German placeholder — the CFG-1
/// Python slice owns the authoritative prompt text and will overwrite
/// these rows via a one-time startup-sync the first time the extractor
/// comes up against a DB that still shows the placeholder value. This
/// keeps the backend migration from bundling a multi-kilobyte prompt
/// copy that would have to be kept in lockstep with the Python source.
/// </para>
/// </summary>
public static class ExtractorConfigDefaults
{
    /// <summary>
    /// One registry row — key, type hint, and the default JSON-encoded
    /// value. Kept as a value-record so the registry is iterable without
    /// allocation per access.
    /// </summary>
    public sealed record Entry(
        string Key,
        ExtractorConfigValueType ValueType,
        string DefaultValueJson);

    /// <summary>
    /// The registry, ordered the same way the admin UI groups keys
    /// (LLM → features → pipeline thresholds). Consumers that need a
    /// dictionary lookup build one off this list.
    /// </summary>
    public static IReadOnlyList<Entry> All { get; } = new Entry[]
    {
        // ── Structured extraction (gpt-4.1-mini Responses API) ──────────
        // CFG-1 seed: placeholder. The Python one-time startup-sync
        // overwrites this with SYSTEM_PROMPT_DE from
        // apps/python-extractor/src/extractor/prompts/recipe_extraction.py
        // the first time the extractor sees the placeholder.
        new("llm.structured.system_prompt", ExtractorConfigValueType.String,
            "\"PLACEHOLDER_STRUCTURED_PROMPT\""),
        new("llm.structured.temperature", ExtractorConfigValueType.Float, "0"),
        new("llm.structured.max_completion_tokens", ExtractorConfigValueType.Int, "2048"),
        new("llm.structured.deployment", ExtractorConfigValueType.String, "\"gpt-4.1-mini\""),

        // ── Chat (gpt-5.1-chat) ──
        // CFG-1 seed: placeholder; Python overwrites with
        // CHAT_SYSTEM_PROMPT_DE from
        // apps/python-extractor/src/extractor/prompts/chat.py.
        new("llm.chat.system_prompt", ExtractorConfigValueType.String,
            "\"PLACEHOLDER_CHAT_PROMPT\""),
        new("llm.chat.max_completion_tokens", ExtractorConfigValueType.Int, "2048"),
        new("llm.chat.deployment", ExtractorConfigValueType.String, "\"gpt-5.1-chat\""),

        // ── Vision (photo import) ──
        // CFG-1 seed: placeholder; Python overwrites with the photo
        // vision prompt from apps/python-extractor/src/extractor/prompts/
        // photo_recipe.py on first startup.
        new("llm.vision.system_prompt", ExtractorConfigValueType.String,
            "\"PLACEHOLDER_VISION_PROMPT\""),
        new("llm.vision.temperature", ExtractorConfigValueType.Float, "0"),
        new("llm.vision.deployment", ExtractorConfigValueType.String, "\"gpt-4.1-mini\""),
        new("llm.vision.max_completion_tokens", ExtractorConfigValueType.Int, "2048"),

        // ── Feature flags (kill switches) ──
        new("feature.video_import_enabled", ExtractorConfigValueType.Bool, "true"),
        new("feature.blog_follow_enabled", ExtractorConfigValueType.Bool, "true"),
        new("feature.nutrition_estimate_enabled", ExtractorConfigValueType.Bool, "true"),
        new("feature.thumbnail_auto_attach_enabled", ExtractorConfigValueType.Bool, "true"),
        new("feature.chat_enabled", ExtractorConfigValueType.Bool, "true"),

        // ── Pipeline thresholds ──
        // Defaults mirror the Python constants as of v0.11.0 — see the
        // file paths in the class-level XML doc for the source.
        new("pipeline.min_transcript_chars", ExtractorConfigValueType.Int, "20"),
        new("pipeline.component_label_max", ExtractorConfigValueType.Int, "50"),
        new("pipeline.generic_label_blacklist", ExtractorConfigValueType.StringList,
            "[\"hauptzutaten\",\"zutaten\",\"hauptgericht\",\"ingredients\",\"main\",\"main ingredients\",\"recipe\"]"),
        new("pipeline.shortener_hosts", ExtractorConfigValueType.StringList,
            "[\"bit.ly\",\"tinyurl.com\",\"lnk.bio\",\"linktr.ee\",\"t.co\",\"ow.ly\",\"buff.ly\",\"goo.gl\"]"),
        new("pipeline.shortener_max_redirects", ExtractorConfigValueType.Int, "3"),
        new("pipeline.shortener_head_timeout_seconds", ExtractorConfigValueType.Float, "5"),
    };

    /// <summary>
    /// Lookup dictionary keyed by <see cref="Entry.Key"/>. Built once
    /// and cached — the registry is immutable.
    /// </summary>
    public static IReadOnlyDictionary<string, Entry> ByKey { get; } =
        All.ToDictionary(e => e.Key, e => e);
}
