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

import logging
from collections.abc import Sequence

from extractor.llm import LLMProvider, VisionInput
from extractor.pipeline.post_process import post_process
from extractor.pipeline.types import ExtractionResult
from extractor.pipeline.video import ExtractionError
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

    logger.info("extract_from_photos start count=%d", len(photo_urls))

    images: list[VisionInput] = [{"image_url": url, "detail": "auto"} for url in photo_urls]
    instruction = build_photo_instruction(len(photo_urls))

    llm_output = await provider.vision_extract(
        system_prompt=SYSTEM_PROMPT_DE,
        images=images,
        instruction=instruction,
        json_schema=PHOTO_RECIPE_SCHEMA,
    )
    logger.info("extract_from_photos llm_done keys=%d", len(llm_output))

    # ``original_url`` pins the response's ``source_url`` — the
    # Vision-LLM's fabricated URL is discarded.
    # ``fallback_thumbnail=None``: photos *are* the thumbnail source;
    # the .NET side (P2-6) can pick one of the uploaded photos as the
    # recipe thumbnail. We don't second-guess it here.
    return post_process(
        llm_output,
        original_url=_PHOTO_SOURCE_SENTINEL,
        fallback_thumbnail=None,
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


__all__ = ["extract_from_photos"]
