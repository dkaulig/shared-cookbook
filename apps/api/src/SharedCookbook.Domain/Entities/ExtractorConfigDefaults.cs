using System.Collections.Generic;
using System.Linq;

namespace SharedCookbook.Domain.Entities;

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
/// keys the default here is the literal sentinel string
/// <c>"PLACEHOLDER_*_PROMPT"</c>. The python-extractor's startup hook
/// (<c>apps/python-extractor/src/extractor/prompt_seed.py</c>) posts
/// the real DE prompts to <c>POST /api/internal/extractor-config/seed-prompts</c>
/// (see <see cref="SharedCookbook.Api.Endpoints.InternalExtractorConfigEndpoints"/>);
/// the endpoint replaces any row that still carries a
/// <c>PLACEHOLDER_</c> value while preserving admin edits. This keeps
/// the backend migration from bundling a multi-kilobyte prompt copy
/// that would have to be kept in lockstep with the Python source.
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
        // ── Structured extraction (gpt-4.1 Responses API) ──────────
        // CFG-1b: placeholder string. The python-extractor's startup
        // hook (apps/python-extractor/src/extractor/prompt_seed.py)
        // POSTs SYSTEM_PROMPT_DE from prompts/recipe_extraction.py to
        // /api/internal/extractor-config/seed-prompts; the endpoint
        // replaces this row idempotently while preserving any later
        // admin edit.
        //
        // COMP-2 (2026-04-23): default bumped from gpt-4.1-mini to
        // gpt-4.1. The mini model collapsed multi-block recipe captions
        // (e.g. "Butter Chicken Sauce Base / Curry Spice Blend /
        // Finishing Ingredients / Rice") into a single component when
        // the Whisper transcript was narrative + non-block-structured.
        // gpt-4.1 (full) weights the structured caption correctly even
        // with a noisy transcript. Pricing: 5× gpt-4.1-mini ($2/$8/$0.5
        // vs $0.4/$1.6/$0.1 per 1M tokens) — about $0.015 vs $0.003
        // per import. Absolute cost still trivial for a family app.
        new("llm.structured.system_prompt", ExtractorConfigValueType.String,
            "\"PLACEHOLDER_STRUCTURED_PROMPT\""),
        new("llm.structured.temperature", ExtractorConfigValueType.Float, "0"),
        // CFG-1 (2026-04-26): default bumped from 2048 → 4096 after the
        // production truncation bug (v0.15.2): a 3-component German
        // recipe ran a few hundred tokens over the 2048 cap, Azure
        // returned status="incomplete" / reason="max_output_tokens",
        // the partial JSON failed to parse, and the operator log read
        // the misleading "schema_mismatch". 4096 stays comfortably
        // inside the gpt-4.1-mini ceiling of 8192 and admins can still
        // override per deployment via this same key (CFG-1).
        new("llm.structured.max_completion_tokens", ExtractorConfigValueType.Int, "4096"),
        new("llm.structured.deployment", ExtractorConfigValueType.String, "\"gpt-4.1\""),

        // ── Chat (gpt-5.1-chat) ──
        // CFG-1b: placeholder string. The python-extractor's startup
        // hook posts TO_RECIPE_SYSTEM_PROMPT_DE from prompts/chat.py
        // here. The conversational chat-turn prompt itself lives in
        // .NET (Services/ChatSystemPrompt.BasePrompt) post-CR5 and is
        // NOT consumed from this registry — so the row is named after
        // its actual audience: the chat-to-recipe extraction pipeline
        // (Whisper transcript → structured recipe). Editing this row
        // through /admin/extractor never affected the chat assistant.
        new("llm.chat_to_recipe.system_prompt", ExtractorConfigValueType.String,
            "\"PLACEHOLDER_CHAT_PROMPT\""),
        new("llm.chat.max_completion_tokens", ExtractorConfigValueType.Int, "4096"),
        new("llm.chat.deployment", ExtractorConfigValueType.String, "\"gpt-5.1-chat\""),

        // ── Vision (photo import) ──
        // CFG-1b: placeholder string. The python-extractor's startup
        // hook posts SYSTEM_PROMPT_DE from prompts/photo_recipe.py to
        // /api/internal/extractor-config/seed-prompts; same idempotent
        // contract as the structured row.
        new("llm.vision.system_prompt", ExtractorConfigValueType.String,
            "\"PLACEHOLDER_VISION_PROMPT\""),
        new("llm.vision.temperature", ExtractorConfigValueType.Float, "0"),
        new("llm.vision.deployment", ExtractorConfigValueType.String, "\"gpt-4.1-mini\""),
        new("llm.vision.max_completion_tokens", ExtractorConfigValueType.Int, "4096"),

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
