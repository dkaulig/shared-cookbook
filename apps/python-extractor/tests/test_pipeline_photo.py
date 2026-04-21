"""Tests for :func:`extract_from_photos` — the Vision-LLM pipeline glue (P2-3)."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import pytest

from extractor.llm import LLMProvider, LLMProviderError, TokenUsage, VisionInput
from extractor.pipeline.photo import extract_from_photos
from extractor.pipeline.video import ExtractionError


def _canonical_vision_response() -> dict[str, Any]:
    """A clean Vision-LLM reply matching PHOTO_RECIPE_SCHEMA.

    COMP-1: ingredients + steps live inside the single default
    component now; the photo path almost never produces multi-component
    recipes (handwritten cards are one thing) so a single ``label=None``
    component is the happy shape.
    """
    return {
        "title": "Omas Kaiserschmarrn",
        "description": "Handgeschrieben, alte Familienrezept-Karte.",
        "servings": 4,
        "difficulty": 2,
        "prep_minutes": 15,
        "cook_minutes": 20,
        "components": [
            {
                "label": None,
                "position": 0,
                "ingredients": [
                    {
                        "name": "Mehl",
                        "quantity": "250",
                        "unit": "g",
                        "note": None,
                        "confidence": "high",
                    },
                    {
                        "name": "Rosinen",
                        "quantity": "eine",
                        "unit": "Tasse",
                        "note": None,
                        "confidence": "handwritten_uncertain",
                    },
                ],
                "steps": [
                    {"position": 1, "content": "Teig anrühren.", "confidence": "high"},
                    {"position": 2, "content": "In Pfanne braten.", "confidence": "medium"},
                ],
            }
        ],
        "tags": ["dessert", "klassiker"],
        "source_url": "photos://upload",
        "thumbnail_url": None,
    }


def _stub_usage() -> TokenUsage:
    return {
        "prompt_tokens": 500,
        "completion_tokens": 80,
        "cached_prompt_tokens": 0,
        "model": "gpt-4.1-mini",
    }


class _CapturingVisionProvider(LLMProvider):
    """Records every ``vision_extract`` call + returns a scripted response.

    We don't use :class:`MockLLMProvider` for the photo pipeline tests
    because the pipeline code is what composes the instruction +
    images, and we want to assert *exactly* what it passed — capturing
    the kwargs is easier than pre-computing the mock's script key.
    """

    def __init__(
        self,
        response: dict[str, Any],
        *,
        usage: TokenUsage | None = None,
    ) -> None:
        self.response = response
        self.usage: TokenUsage = usage if usage is not None else _stub_usage()
        self.last_system_prompt: str | None = None
        self.last_images: list[VisionInput] = []
        self.last_instruction: str | None = None
        self.last_schema: dict[str, Any] | None = None
        self.calls = 0

    async def extract_structured(
        self,
        system_prompt: str,
        messages: Sequence[Any],
        json_schema: dict[str, Any],
    ) -> tuple[dict[str, Any], TokenUsage]:
        raise NotImplementedError

    async def chat(
        self,
        system_prompt: str,
        messages: Sequence[Any],
    ) -> tuple[str, TokenUsage]:
        raise NotImplementedError

    async def vision_extract(
        self,
        system_prompt: str,
        images: Sequence[VisionInput],
        instruction: str,
        json_schema: dict[str, Any],
    ) -> tuple[dict[str, Any], TokenUsage]:
        self.calls += 1
        self.last_system_prompt = system_prompt
        self.last_images = [dict(img) for img in images]  # type: ignore[misc]
        self.last_instruction = instruction
        self.last_schema = json_schema
        return dict(self.response), self.usage


class _FailingVisionProvider(LLMProvider):
    """Always raises the configured error from ``vision_extract``."""

    def __init__(self, error: LLMProviderError) -> None:
        self.error = error

    async def extract_structured(
        self,
        system_prompt: str,
        messages: Sequence[Any],
        json_schema: dict[str, Any],
    ) -> tuple[dict[str, Any], TokenUsage]:
        raise self.error

    async def chat(
        self,
        system_prompt: str,
        messages: Sequence[Any],
    ) -> tuple[str, TokenUsage]:
        raise self.error

    async def vision_extract(
        self,
        system_prompt: str,
        images: Sequence[VisionInput],
        instruction: str,
        json_schema: dict[str, Any],
    ) -> tuple[dict[str, Any], TokenUsage]:
        raise self.error


# ─────────────────────────────────────────────────────────────────────
# Input validation
# ─────────────────────────────────────────────────────────────────────


async def test_extract_from_photos_rejects_empty_list() -> None:
    """Zero photos is useless for Vision-LLM; map to a 422 at the endpoint."""
    provider = _CapturingVisionProvider(_canonical_vision_response())
    with pytest.raises(ExtractionError) as exc_info:
        await extract_from_photos([], provider=provider)
    assert exc_info.value.code == "invalid_input"
    # Provider never called.
    assert provider.calls == 0


async def test_extract_from_photos_rejects_eleven_photos() -> None:
    """11 photos exceeds the documented cap; refuse up-front."""
    provider = _CapturingVisionProvider(_canonical_vision_response())
    urls = [f"https://example.com/photo-{i}.jpg" for i in range(11)]
    with pytest.raises(ExtractionError) as exc_info:
        await extract_from_photos(urls, provider=provider)
    assert exc_info.value.code == "invalid_input"
    # German message — caller surfaces to the user verbatim.
    assert "10" in str(exc_info.value)
    assert provider.calls == 0


async def test_extract_from_photos_rejects_non_http_urls() -> None:
    """Only http[s] URLs; reject everything else (data:, file:, etc.) with
    a clear 422 so a caller misusing the endpoint fails loud."""
    provider = _CapturingVisionProvider(_canonical_vision_response())
    with pytest.raises(ExtractionError) as exc_info:
        await extract_from_photos(
            ["data:image/jpeg;base64,AAAA"],
            provider=provider,
        )
    assert exc_info.value.code == "invalid_input"
    assert provider.calls == 0


async def test_extract_from_photos_rejects_empty_string_urls() -> None:
    """Empty string is as bad as missing — reject before calling the LLM."""
    provider = _CapturingVisionProvider(_canonical_vision_response())
    with pytest.raises(ExtractionError) as exc_info:
        await extract_from_photos(["https://example.com/a.jpg", ""], provider=provider)
    assert exc_info.value.code == "invalid_input"
    assert provider.calls == 0


# ─────────────────────────────────────────────────────────────────────
# Happy paths
# ─────────────────────────────────────────────────────────────────────


async def test_extract_from_photos_single_photo_calls_vision_extract() -> None:
    """One photo → one vision_extract call with the right instruction."""
    provider = _CapturingVisionProvider(_canonical_vision_response())
    result = await extract_from_photos(
        ["https://example.com/a.jpg"],
        provider=provider,
    )
    assert provider.calls == 1
    # Pipeline forwarded the photo as-is with detail=auto so Azure picks.
    assert provider.last_images == [
        {"image_url": "https://example.com/a.jpg", "detail": "auto"},
    ]
    assert provider.last_system_prompt is not None
    assert "Rezept-Digitalisierer" in provider.last_system_prompt
    assert provider.last_instruction is not None
    assert "1 Fotos" in provider.last_instruction
    # Post-processed result: LLM's fake source_url got pinned to the
    # sentinel ``photos://upload`` — photos don't have a single source
    # URL, and we must not let the LLM dictate one.
    assert result["recipe"]["title"] == "Omas Kaiserschmarrn"
    assert result["recipe"]["source_url"] == "photos://upload"


async def test_extract_from_photos_multi_photo_preserves_input_order() -> None:
    """3 photos arrive at ``vision_extract`` in caller order."""
    provider = _CapturingVisionProvider(_canonical_vision_response())
    urls = [
        "https://example.com/p1.jpg",
        "https://example.com/p2.jpg",
        "https://example.com/p3.jpg",
    ]
    await extract_from_photos(urls, provider=provider)
    assert [img["image_url"] for img in provider.last_images] == urls
    assert provider.last_instruction is not None
    assert "3 Fotos" in provider.last_instruction
    assert "Seite 1" in provider.last_instruction
    assert "Seite 3" in provider.last_instruction


async def test_extract_from_photos_passes_photo_schema_not_base_schema() -> None:
    """The Vision call uses PHOTO_RECIPE_SCHEMA (with the extra
    ``handwritten_uncertain`` enum value) — not the URL path's
    RECIPE_SCHEMA. Drift between the two would strip the flag."""
    from extractor.prompts.photo_recipe import PHOTO_RECIPE_SCHEMA

    provider = _CapturingVisionProvider(_canonical_vision_response())
    await extract_from_photos(["https://example.com/a.jpg"], provider=provider)
    assert provider.last_schema is PHOTO_RECIPE_SCHEMA


async def test_extract_from_photos_preserves_handwritten_uncertain_confidence() -> None:
    """The new confidence literal survives post-processing end-to-end."""
    provider = _CapturingVisionProvider(_canonical_vision_response())
    result = await extract_from_photos(
        ["https://example.com/a.jpg", "https://example.com/b.jpg"],
        provider=provider,
    )
    # The second ingredient in the canonical response is
    # handwritten_uncertain + has a quantity → post-process keeps it.
    # COMP-1: ingredients now live inside the default component.
    all_ingredients = [ing for c in result["recipe"]["components"] for ing in c["ingredients"]]
    rosinen = next(i for i in all_ingredients if i["name"] == "Rosinen")
    assert rosinen["confidence"] == "handwritten_uncertain"
    # Old German unit preserved — no metric conversion at the pipeline layer.
    assert rosinen["unit"] == "Tasse"
    assert rosinen["quantity"] == "eine"


async def test_extract_from_photos_renumbers_step_positions() -> None:
    """Post-process normalises positions to 1..N in input order — the
    shared rule from the URL pipeline applies here too."""
    response = _canonical_vision_response()
    # COMP-1: steps live inside the single default component.
    response["components"][0]["steps"] = [
        {"position": 7, "content": "Schritt A.", "confidence": "high"},
        {"position": 3, "content": "Schritt B.", "confidence": "high"},
        {"position": 9, "content": "Schritt C.", "confidence": "medium"},
    ]
    provider = _CapturingVisionProvider(response)
    result = await extract_from_photos(
        ["https://example.com/a.jpg"],
        provider=provider,
    )
    all_steps = [step for c in result["recipe"]["components"] for step in c["steps"]]
    positions = [step["position"] for step in all_steps]
    assert positions == [1, 2, 3]


async def test_extract_from_photos_bubbles_provider_unavailable() -> None:
    """Azure outage → LLMProviderError(provider_unavailable) propagates
    so the HTTP layer can surface HTTP 503."""
    provider = _FailingVisionProvider(
        LLMProviderError("Azure down", code="provider_unavailable"),
    )
    with pytest.raises(LLMProviderError) as exc_info:
        await extract_from_photos(
            ["https://example.com/a.jpg"],
            provider=provider,
        )
    assert exc_info.value.code == "provider_unavailable"


async def test_extract_from_photos_defaults_to_missing_when_quantity_blank() -> None:
    """Post-process rule applies: no quantity → confidence='missing'
    regardless of what the Vision-LLM claimed."""
    response = _canonical_vision_response()
    # COMP-1: ingredients live inside the single default component.
    response["components"][0]["ingredients"] = [
        {
            "name": "Eine Prise Salz",
            "quantity": None,
            "unit": None,
            "note": None,
            # LLM claims high — post-process overrides to missing.
            "confidence": "high",
        }
    ]
    provider = _CapturingVisionProvider(response)
    result = await extract_from_photos(
        ["https://example.com/a.jpg"],
        provider=provider,
    )
    all_ingredients = [ing for c in result["recipe"]["components"] for ing in c["ingredients"]]
    assert all_ingredients[0]["confidence"] == "missing"


async def test_extract_from_photos_attaches_usage_to_result() -> None:
    """PF2: Vision-call usage surfaces on the result for header emission."""
    provider = _CapturingVisionProvider(
        _canonical_vision_response(),
        usage={
            "prompt_tokens": 1200,
            "completion_tokens": 250,
            "cached_prompt_tokens": 100,
            "model": "gpt-4.1-mini",
        },
    )
    result = await extract_from_photos(
        ["https://example.com/a.jpg"],
        provider=provider,
    )
    assert "usage" in result
    usage = result["usage"]
    assert usage["prompt_tokens"] == 1200
    assert usage["completion_tokens"] == 250
    assert usage["cached_prompt_tokens"] == 100
    assert usage["model"] == "gpt-4.1-mini"


async def test_extract_from_photos_accepts_http_and_https() -> None:
    """Plain http:// signed URLs are allowed (no TLS required in the
    internal SeaweedFS → .NET → Python hop)."""
    provider = _CapturingVisionProvider(_canonical_vision_response())
    await extract_from_photos(
        ["http://seaweedfs.internal/a.jpg"],
        provider=provider,
    )
    assert provider.calls == 1


# ─────────────────────────────────────────────────────────────────────
# PV2 — ProgressReporter integration
# ─────────────────────────────────────────────────────────────────────


from extractor.progress import (  # noqa: E402 — keep PV2 section self-contained
    NullProgressReporter,
    ProgressEvent,
    ProgressReporter,
)


class _CapturingReporter(ProgressReporter):
    """Records events instead of POSTing. Same shape as the url-test helper."""

    def __init__(self) -> None:
        super().__init__(callback_url=None, callback_token=None, attempt=1)
        self.events: list[ProgressEvent] = []

    async def report(self, event: ProgressEvent, *, force: bool = False) -> None:
        # ``force`` is ignored — this in-memory recorder bypasses the
        # throttle entirely because integration tests care about the
        # emitted event stream, not throttle state.
        self.events.append(event)

    async def _post(self, event: ProgressEvent) -> None:
        return


async def test_photo_pipeline_reports_vision_and_post_processing() -> None:
    """Photo path emits ``vision_analysis`` + ``post_processing`` phases."""
    provider = _CapturingVisionProvider(_canonical_vision_response())
    reporter = _CapturingReporter()
    await extract_from_photos(
        ["https://example.com/photo.jpg"],
        provider=provider,
        reporter=reporter,
    )
    phases = [e.phase for e in reporter.events]
    # dedup to phase transitions
    deduped: list[str] = []
    for p in phases:
        if not deduped or deduped[-1] != p:
            deduped.append(p)
    assert deduped == ["vision_analysis", "post_processing"]


async def test_photo_pipeline_null_reporter_reproduces_legacy_output() -> None:
    """:class:`NullProgressReporter` doesn't alter the extraction result."""
    provider_null = _CapturingVisionProvider(_canonical_vision_response())
    provider_default = _CapturingVisionProvider(_canonical_vision_response())
    result_null = await extract_from_photos(
        ["https://example.com/photo.jpg"],
        provider=provider_null,
        reporter=NullProgressReporter(),
    )
    result_default = await extract_from_photos(
        ["https://example.com/photo.jpg"],
        provider=provider_default,
    )
    assert result_null["recipe"] == result_default["recipe"]
