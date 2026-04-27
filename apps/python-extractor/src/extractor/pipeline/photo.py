"""Top-level photo → structured-recipe pipeline glue (P2-3).

Mirrors :mod:`extractor.pipeline.url` in shape but dispatches to
:meth:`LLMProvider.vision_extract` rather than the
structured-text extractor. The two paths share the
:class:`ExtractionResult` wire shape and the defensive
:func:`post_process` step.

Flow:

1. Validate the caller-supplied photo URLs (1..10, all http[s]). A
   violation raises :class:`ExtractionError` with
   ``code="invalid_input"``; the HTTP layer maps it to 422.
2. Build the per-call instruction with :func:`build_photo_instruction`
   (the system prompt is static and lives at module scope).
3. Hand every URL to the provider at ``detail="auto"`` so Azure picks
   the tier (``high`` for dense handwriting, ``low`` for a single
   clean photograph).
4. Post-process with the shared :func:`post_process` rules — clamped
   servings, missing-quantity flag, step positions renumbered 1..N in
   input order, ``source_url`` pinned to the sentinel
   ``"photos://upload"`` because photos don't have a canonical source
   URL the frontend can link to.
"""

from __future__ import annotations

import hashlib
import logging
from collections.abc import Sequence

from extractor.config_loader import ExtractorConfig, get_flag, get_float, get_int, get_str
from extractor.llm import LLMProvider, TokenUsage, VisionInput
from extractor.pipeline.post_process import post_process
from extractor.pipeline.types import ConfigSnapshot, ExtractionResult
from extractor.pipeline.video import ExtractionError
from extractor.progress import NullProgressReporter, ProgressEvent, ProgressReporter
from extractor.prompts.language import SupportedLanguage, apply_language_directive
from extractor.prompts.photo_recipe import (
    PHOTO_RECIPE_SCHEMA,
    SYSTEM_PROMPT_DE,
    build_photo_instruction,
)

logger = logging.getLogger("extractor.pipeline.photo")

_MIN_PHOTOS: int = 1
_MAX_PHOTOS: int = 10

# Sentinel ``source_url`` — photos have no single source URL the
# frontend can link back to, but :class:`ExtractionResult` requires the
# field. The ``photos://`` scheme is obviously not a real URL, which is
# the point: the frontend can branch on it to hide the "Quelle
# öffnen" link.
_PHOTO_SOURCE_SENTINEL: str = "photos://upload"

# Vision detail hint. ``"auto"`` lets Azure pick; cheap for clean print
# scans, burns more tokens on dense handwriting. We don't expose this
# as a knob — the caller has no way to know what's in their photo.
_VISION_DETAIL: str = "auto"


async def extract_from_photos(
    photo_urls: Sequence[str],
    *,
    provider: LLMProvider,
    reporter: ProgressReporter | None = None,
    config: ExtractorConfig | None = None,
    lang: SupportedLanguage = "en",
) -> ExtractionResult:
    """Run the full photos → structured-recipe pipeline.

    Parameters
    ----------
    photo_urls
        Ordered list of 1..10 http[s] URLs pointing at already-uploaded
        photos. Order defines the reading sequence for multi-page
        recipes (page 1 first).
    provider
        :class:`LLMProvider` used for the Vision call. Usually
        ``build_provider(Settings())``; tests pass a scripted fake.
    reporter
        Optional :class:`ProgressReporter` for phase/progress callbacks
        to the .NET side. Defaults to a :class:`NullProgressReporter`
        so existing tests that don't care about progress pass nothing.
    config
        CFG-1 :class:`ExtractorConfig` — hot-configurable vision params
        (prompt / temperature / deployment / max-tokens) + nutrition
        flag. ``None`` keeps the hardcoded defaults.

    Raises
    ------
    ExtractionError
        Code ``"invalid_input"`` when ``photo_urls`` fails the 1..10
        range or any URL is not ``http[s]``.
    LLMProviderError
        Propagates unchanged from the provider — the endpoint layer
        maps ``provider_unavailable`` → 503, etc.
    """
    _validate_photo_urls(photo_urls)
    active_reporter: ProgressReporter = reporter or NullProgressReporter()

    logger.info("extract_from_photos start count=%d", len(photo_urls))

    # CFG-1 — resolve hot params once up front.
    system_prompt_base = await get_str(config, "llm.vision.system_prompt", SYSTEM_PROMPT_DE)
    # LANG-1 — language directive lives at the end of the prompt; see
    # ``pipeline.url._run_llm_structuring`` for the rationale. POLISH-1
    # adds prepend redundancy for providers that opt in (Ollama).
    system_prompt = apply_language_directive(
        system_prompt_base,
        lang,
        redundant=provider.requires_redundant_language_directive,
    )
    temperature = await get_float(config, "llm.vision.temperature", 0.0)
    max_completion_tokens = await get_int(config, "llm.vision.max_completion_tokens", 2048)
    deployment = await get_str(config, "llm.vision.deployment", "gpt-4.1-mini")
    nutrition_enabled = await get_flag(config, "feature.nutrition_estimate_enabled", True)
    component_label_max = await get_int(config, "pipeline.component_label_max", 50)

    images: list[VisionInput] = [{"image_url": url, "detail": "auto"} for url in photo_urls]
    instruction = build_photo_instruction(len(photo_urls))

    # Single-shot Azure Vision call — no mid-call granularity available,
    # so we straddle it with 0% + 95% events. The .NET side derives the
    # actual wall-clock animation; 95% means "waiting for Vision reply".
    await active_reporter.report(ProgressEvent(phase="vision_analysis", phase_progress=0))
    llm_output, usage = await _call_vision_extract(
        provider,
        system_prompt=system_prompt,
        images=images,
        instruction=instruction,
        json_schema=PHOTO_RECIPE_SCHEMA,
        temperature=temperature,
        max_completion_tokens=max_completion_tokens,
        deployment=deployment,
    )
    logger.info("extract_from_photos llm_done keys=%d", len(llm_output))
    # The 95% tick is the canonical end-of-phase signal for
    # ``vision_analysis`` — it lands right before the phase
    # transition. Without ``force=True`` the reporter's 500 ms
    # throttle would drop this event when the Vision call returned
    # faster than the throttle window (measured in every test run),
    # leaving the UI stalled at the 0% boundary. ``force`` bypasses
    # the throttle specifically for these "final tick before
    # transition" events.
    await active_reporter.report(
        ProgressEvent(phase="vision_analysis", phase_progress=95),
        force=True,
    )

    # ``original_url`` pins the response's ``source_url`` — the
    # Vision-LLM's fabricated URL is discarded.
    # ``fallback_thumbnail=None``: photos *are* the thumbnail source;
    # the .NET side (P2-6) can pick one of the uploaded photos as the
    # recipe thumbnail. We don't second-guess it here.
    await active_reporter.report(ProgressEvent(phase="post_processing", phase_progress=0))
    # LANG-1 — hash the base prompt (without the per-request language
    # directive) so the admin dashboard sees a single prompt_hash per
    # configured prompt rather than one per UI language.
    snapshot: ConfigSnapshot = {
        "prompt_hash": (
            "sha256:" + hashlib.sha256(system_prompt_base.encode("utf-8")).hexdigest()[:16]
        ),
        "temperature": temperature,
        "max_completion_tokens": max_completion_tokens,
        "deployment": deployment,
        "prompt_version": config.version_of("llm.vision.system_prompt") if config else None,
        # AI-normalize toggle (2026-04-27) is URL-blog-only — the photo
        # path never opts in, so the audit field is stamped ``False``
        # to keep the wire shape symmetric.
        "ai_normalize_active": False,
    }
    return post_process(
        llm_output,
        original_url=_PHOTO_SOURCE_SENTINEL,
        usage=usage,
        nutrition_enabled=nutrition_enabled,
        component_label_max=component_label_max,
        config_snapshot=snapshot,
    )


# ─────────────────────────────────────────────────────────────────────
# Validation
# ─────────────────────────────────────────────────────────────────────


def _validate_photo_urls(photo_urls: Sequence[str]) -> None:
    """Enforce the 1..10 cap + http[s] scheme.

    Intentionally does **not** enforce a specific host — .NET (P2-6)
    is the authentication boundary and signs URLs via HMAC, so by the
    time a URL lands here it's already been vetted upstream.
    """
    count = len(photo_urls)
    if count < _MIN_PHOTOS:
        raise ExtractionError(
            "invalid_input",
            "Mindestens 1 Foto wird benötigt.",
        )
    if count > _MAX_PHOTOS:
        raise ExtractionError(
            "invalid_input",
            f"Maximal {_MAX_PHOTOS} Fotos pro Import.",
        )
    for url in photo_urls:
        if not isinstance(url, str) or not url:
            raise ExtractionError(
                "invalid_input",
                "Alle Foto-URLs müssen nicht-leere Strings sein.",
            )
        if not (url.startswith("https://") or url.startswith("http://")):
            raise ExtractionError(
                "invalid_input",
                "Foto-URLs müssen mit http:// oder https:// beginnen.",
            )


async def _call_vision_extract(
    provider: LLMProvider,
    *,
    system_prompt: str,
    images: list[VisionInput],
    instruction: str,
    json_schema: dict[str, object],
    temperature: float,
    max_completion_tokens: int,
    deployment: str | None,
) -> tuple[dict[str, object], TokenUsage]:
    """Forward vision params on Azure, drop them on the mock.

    See :func:`extractor.pipeline.url._call_extract_structured` for the
    same pattern. Azure accepts the CFG-1 overrides; the
    :class:`MockLLMProvider` only knows the base signature.
    """
    from extractor.llm.azure_openai import AzureOpenAIProvider

    if isinstance(provider, AzureOpenAIProvider):
        return await provider.vision_extract(
            system_prompt,
            images,
            instruction,
            json_schema,
            temperature=temperature,
            max_completion_tokens=max_completion_tokens,
            deployment=deployment,
        )
    return await provider.vision_extract(
        system_prompt,
        images,
        instruction,
        json_schema,
    )


__all__ = ["extract_from_photos"]
