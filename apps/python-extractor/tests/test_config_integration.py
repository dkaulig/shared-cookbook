"""CFG-1 integration tests — constants and feature-flags flow through config.

Covers the three pieces the design doc requires beyond the loader itself:

1. Constant-replacement — each hardcoded value now reads via
   ``config.get()`` with the old default as the 2nd arg. When the
   loader reports a non-default value, the pipeline uses the override.
2. Feature-flag gating (python scope only):
   - ``feature.video_import_enabled`` — ``_run_video_path`` raises
     ``feature_disabled``.
   - ``feature.blog_follow_enabled`` — caption-blog-follow + direct
     blog path skip.
   - ``feature.nutrition_estimate_enabled`` — ``post_process`` null-outs
     the estimate regardless of Azure's reply.
3. ``config_snapshot`` ride-along — every structured-extraction
   ``ResultJson`` carries the snapshot with prompt hash / temperature /
   max-tokens / deployment / prompt-version.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from unittest.mock import patch

import httpx
import pytest

from extractor.config_loader import ExtractorConfig
from extractor.llm import MockLLMProvider
from extractor.llm.mock import make_script_key
from extractor.pipeline.photo import extract_from_photos
from extractor.pipeline.post_process import post_process
from extractor.pipeline.types import ConfigSnapshot
from extractor.pipeline.url import _extract_caption_blog_url, extract_from_url
from extractor.pipeline.video import (
    ExtractionError,
    StubDownloader,
    StubTranscriber,
    VideoAssets,
)
from extractor.prompts.photo_recipe import SYSTEM_PROMPT_DE as PHOTO_SYSTEM_PROMPT_DE
from extractor.prompts.photo_recipe import build_photo_instruction
from extractor.prompts.recipe_extraction import (
    SYSTEM_PROMPT_DE,
    build_user_message,
)


def _canonical_llm_response() -> dict[str, Any]:
    """Minimal valid LLM response — one component, one ingredient, one step."""
    return {
        "title": "Testrezept",
        "description": "Ein Test.",
        "servings": 4,
        "difficulty": 2,
        "prep_minutes": 10,
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
                    }
                ],
                "steps": [
                    {"position": 1, "content": "Mehl abwiegen.", "confidence": "high"},
                ],
            }
        ],
        "tags": [],
        "source_url": "https://llm.example/bogus",
        "thumbnail_url": None,
        "nutrition_estimate": {"kcal": 420, "protein_g": 12, "carbs_g": 50, "fat_g": 10},
    }


def _make_config(values: dict[str, Any], versions: dict[str, int] | None = None) -> ExtractorConfig:
    """Build a fake ``ExtractorConfig`` pre-populated with ``values``.

    The config reuses the real class so type-match semantics mirror
    production. No HTTP round-trip: we directly seed ``_cache`` +
    ``_cache_expires_at`` so ``.get`` never reaches out.
    """
    import time

    transport = httpx.MockTransport(
        lambda _request: httpx.Response(500, text="should not be called")
    )
    client = httpx.AsyncClient(transport=transport, base_url="http://api.test")
    cfg = ExtractorConfig(client=client, ttl_seconds=60.0)
    cfg._cache = dict(values)
    cfg._versions = dict(versions or {})
    cfg._have_cache = True
    cfg._cache_expires_at = time.monotonic() + 60.0
    return cfg


# ─────────────────────────────────────────────────────────────────────
# post_process — nutrition feature flag + snapshot ride-along
# ─────────────────────────────────────────────────────────────────────


def test_post_process_null_outs_nutrition_when_feature_disabled() -> None:
    """``feature.nutrition_estimate_enabled=False`` → nutrition_estimate=None."""
    llm_output = _canonical_llm_response()
    assert llm_output["nutrition_estimate"] is not None  # sanity — Azure emitted one
    result = post_process(
        llm_output,
        original_url="https://example.test/recipe",
        fallback_thumbnail=None,
        nutrition_enabled=False,
    )
    assert result["recipe"]["nutrition_estimate"] is None


def test_post_process_keeps_nutrition_when_feature_enabled() -> None:
    """``feature.nutrition_estimate_enabled=True`` → normal pass-through."""
    llm_output = _canonical_llm_response()
    result = post_process(
        llm_output,
        original_url="https://example.test/recipe",
        fallback_thumbnail=None,
        nutrition_enabled=True,
    )
    est = result["recipe"]["nutrition_estimate"]
    assert est is not None
    assert est["kcal"] == 420


def test_post_process_accepts_config_snapshot() -> None:
    """``post_process`` propagates the caller-built ``ConfigSnapshot`` verbatim."""
    snapshot: ConfigSnapshot = {
        "prompt_hash": "sha256:deadbeefcafe0000",
        "temperature": 0,
        "max_completion_tokens": 2048,
        "deployment": "gpt-4.1-mini",
        "prompt_version": 7,
    }
    result = post_process(
        _canonical_llm_response(),
        original_url="https://example.test/recipe",
        fallback_thumbnail=None,
        config_snapshot=snapshot,
    )
    assert result.get("config_snapshot") == snapshot


def test_post_process_without_snapshot_has_no_key() -> None:
    """Backward-compat: callers that don't pass a snapshot get a result
    without the key (optional on the wire)."""
    result = post_process(
        _canonical_llm_response(),
        original_url="https://example.test/recipe",
        fallback_thumbnail=None,
    )
    assert "config_snapshot" not in result


def test_post_process_honours_custom_component_label_max() -> None:
    """``pipeline.component_label_max`` overrides the hardcoded 50-char cap."""
    llm_output = _canonical_llm_response()
    # Custom 80-char label — would be truncated to 50 with the default,
    # survives intact with a 100-char override.
    long_label = "S" * 80
    llm_output["components"][0]["label"] = long_label
    result = post_process(
        llm_output,
        original_url="https://example.test/recipe",
        fallback_thumbnail=None,
        component_label_max=100,
    )
    assert result["recipe"]["components"][0]["label"] == long_label


def test_post_process_honours_custom_generic_label_blacklist() -> None:
    """``pipeline.generic_label_blacklist`` overrides the hardcoded set."""
    llm_output = _canonical_llm_response()
    # "Spezialsauce" is NOT in the default blacklist but IS in the override.
    # Single-component + blacklisted label → null out.
    llm_output["components"][0]["label"] = "Spezialsauce"
    result = post_process(
        llm_output,
        original_url="https://example.test/recipe",
        fallback_thumbnail=None,
        generic_label_blacklist=["spezialsauce"],
    )
    assert result["recipe"]["components"][0]["label"] is None


# ─────────────────────────────────────────────────────────────────────
# Video feature flag — feature.video_import_enabled
# ─────────────────────────────────────────────────────────────────────


@pytest.fixture()
def _public_dns() -> Iterator[None]:
    """Patch socket.getaddrinfo so _assert_safe_http_target sees hosts as public."""
    import ipaddress
    import socket
    import typing

    def _fake(host: str, *args: typing.Any, **kwargs: typing.Any) -> list[typing.Any]:
        try:
            ipaddress.ip_address(host)
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (host, 0))]
        except ValueError:
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", 0))]

    with patch("extractor.pipeline.url.socket.getaddrinfo", side_effect=_fake):
        yield


async def test_video_path_raises_feature_disabled_when_flag_off(
    _public_dns: None, tmp_path: Path
) -> None:
    """``feature.video_import_enabled=False`` at the top of ``_run_video_path``."""

    config = _make_config({"feature.video_import_enabled": False})
    mp4_path = tmp_path / "fake.mp4"
    mp4_path.write_bytes(b"")
    downloader = StubDownloader(
        assets=VideoAssets(
            mp4_path=mp4_path,
            title="",
            description="",
            thumbnail_url=None,
        )
    )
    transcriber = StubTranscriber(transcript="")
    provider = MockLLMProvider()
    with pytest.raises(ExtractionError) as exc_info:
        await extract_from_url(
            "https://www.youtube.com/watch?v=abc",
            provider=provider,
            downloader=downloader,
            transcriber=transcriber,
            config=config,
        )
    assert exc_info.value.code == "feature_disabled"
    # German user-facing message.
    assert "Video-Import" in str(exc_info.value)


async def test_video_path_still_runs_when_flag_on(_public_dns: None, tmp_path: Path) -> None:
    """Feature ON → video path executes normally."""
    config = _make_config({"feature.video_import_enabled": True})
    mp4_path = tmp_path / "fake.mp4"
    mp4_path.write_bytes(b"")
    downloader = StubDownloader(
        assets=VideoAssets(
            mp4_path=mp4_path,
            title="Das Rezept",
            description="some caption text here",
            thumbnail_url=None,
        )
    )
    transcriber = StubTranscriber(transcript="Transkript text das lang genug ist zum testen.")

    user_message = build_user_message(
        transcript="Transkript text das lang genug ist zum testen.",
        caption="some caption text here",
        blog_text=None,
        thumbnail_url=None,
    )
    key = make_script_key(
        system_prompt=SYSTEM_PROMPT_DE,
        messages=[{"role": "user", "content": user_message}],
    )
    provider = MockLLMProvider(scripted={key: _canonical_llm_response()})

    result = await extract_from_url(
        "https://www.youtube.com/watch?v=abc",
        provider=provider,
        downloader=downloader,
        transcriber=transcriber,
        config=config,
    )
    assert result["recipe"]["title"] == "Testrezept"


# ─────────────────────────────────────────────────────────────────────
# Blog feature flag — feature.blog_follow_enabled
# ─────────────────────────────────────────────────────────────────────


async def test_caption_blog_follow_skipped_when_flag_off(_public_dns: None) -> None:
    """``feature.blog_follow_enabled=False`` → caption-URL follow returns None."""
    caption = "Rezept hier: https://blog.example/recipe"
    async with httpx.AsyncClient(timeout=1.0) as client:
        result = await _extract_caption_blog_url(
            caption,
            source_url="https://facebook.com/x/y",
            client=client,
            blog_follow_enabled=False,
        )
    assert result is None
    # Ensure the config-absent path still finds the URL.
    async with httpx.AsyncClient(timeout=1.0) as client:
        result2 = await _extract_caption_blog_url(
            caption,
            source_url="https://facebook.com/x/y",
            client=client,
            blog_follow_enabled=True,
        )
    assert result2 == "https://blog.example/recipe"


# ─────────────────────────────────────────────────────────────────────
# config_snapshot ride-along on full URL pipeline
# ─────────────────────────────────────────────────────────────────────


async def test_url_pipeline_records_config_snapshot(_public_dns: None, tmp_path: Path) -> None:
    """A full URL-path extraction must emit a ``config_snapshot`` on the result."""
    config = _make_config(
        {
            "feature.video_import_enabled": True,
            "feature.blog_follow_enabled": True,
            "feature.nutrition_estimate_enabled": True,
            "llm.structured.system_prompt": SYSTEM_PROMPT_DE,
            "llm.structured.temperature": 0,
            "llm.structured.max_completion_tokens": 2048,
            "llm.structured.deployment": "gpt-4.1-mini",
        },
        versions={"llm.structured.system_prompt": 7},
    )
    mp4_path = tmp_path / "fake.mp4"
    mp4_path.write_bytes(b"")
    downloader = StubDownloader(
        assets=VideoAssets(
            mp4_path=mp4_path,
            title="Rezept",
            description="",
            thumbnail_url=None,
        )
    )
    transcriber = StubTranscriber(transcript="Transkript lang genug zum testen der pipeline.")
    user_message = build_user_message(
        transcript="Transkript lang genug zum testen der pipeline.",
        caption=None,
        blog_text=None,
        thumbnail_url=None,
    )
    key = make_script_key(
        system_prompt=SYSTEM_PROMPT_DE,
        messages=[{"role": "user", "content": user_message}],
    )
    provider = MockLLMProvider(scripted={key: _canonical_llm_response()})
    result = await extract_from_url(
        "https://www.youtube.com/watch?v=abc",
        provider=provider,
        downloader=downloader,
        transcriber=transcriber,
        config=config,
    )
    snapshot = result.get("config_snapshot")
    assert snapshot is not None
    expected_hash = "sha256:" + hashlib.sha256(SYSTEM_PROMPT_DE.encode("utf-8")).hexdigest()[:16]
    assert snapshot["prompt_hash"] == expected_hash
    assert snapshot["temperature"] == 0
    assert snapshot["max_completion_tokens"] == 2048
    assert snapshot["deployment"] == "gpt-4.1-mini"
    assert snapshot["prompt_version"] == 7


async def test_photo_pipeline_records_config_snapshot() -> None:
    """Photo path snapshot uses the vision prompt/deployment/version."""
    config = _make_config(
        {
            "feature.nutrition_estimate_enabled": True,
            "llm.vision.system_prompt": PHOTO_SYSTEM_PROMPT_DE,
            "llm.vision.temperature": 0,
            "llm.vision.max_completion_tokens": 2048,
            "llm.vision.deployment": "gpt-4.1-mini",
        },
        versions={"llm.vision.system_prompt": 3},
    )
    photo_url = "https://example.test/a.jpg"
    instruction = build_photo_instruction(1)
    key = make_script_key(
        system_prompt=PHOTO_SYSTEM_PROMPT_DE,
        messages=[{"role": "user", "content": instruction}],
        extra=("vision", photo_url, "auto"),
    )
    provider = MockLLMProvider(scripted={key: _canonical_llm_response()})
    result = await extract_from_photos(
        [photo_url],
        provider=provider,
        config=config,
    )
    snapshot = result.get("config_snapshot")
    assert snapshot is not None
    expected_hash = (
        "sha256:" + hashlib.sha256(PHOTO_SYSTEM_PROMPT_DE.encode("utf-8")).hexdigest()[:16]
    )
    assert snapshot["prompt_hash"] == expected_hash
    assert snapshot["prompt_version"] == 3
    assert snapshot["deployment"] == "gpt-4.1-mini"
