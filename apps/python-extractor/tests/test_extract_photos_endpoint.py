"""Tests for the ``POST /extract/photos`` endpoint (P2-3).

All tests override ``get_llm_provider`` with a scripted Vision fake —
no real Azure calls. The .NET side of the world (HMAC auth, photo
upload, signed URLs) lives outside this service, so we accept any
http[s] URL the caller hands in.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from fastapi.testclient import TestClient

from extractor.llm import LLMProvider, LLMProviderError, TokenUsage, VisionInput
from extractor.main import create_app, get_llm_provider


def _canonical_vision_response() -> dict[str, Any]:
    return {
        "title": "Omas Apfelkuchen",
        "description": None,
        "servings": 8,
        "difficulty": 2,
        "prep_minutes": 20,
        "cook_minutes": 60,
        "ingredients": [
            {
                "name": "Äpfel",
                "quantity": "5",
                "unit": "Stück",
                "note": None,
                "confidence": "high",
            },
            {
                "name": "Zimt",
                "quantity": "eine",
                "unit": "Prise",
                "note": None,
                "confidence": "handwritten_uncertain",
            },
        ],
        "steps": [
            {"position": 1, "content": "Äpfel schälen.", "confidence": "high"},
            {"position": 2, "content": "Teig anrühren.", "confidence": "high"},
        ],
        "tags": ["kuchen", "backen"],
        "source_url": "photos://llm-hallucinated",
        "thumbnail_url": None,
    }


def _stub_usage() -> TokenUsage:
    return {
        "prompt_tokens": 800,
        "completion_tokens": 150,
        "cached_prompt_tokens": 0,
        "model": "gpt-4.1-mini",
    }


class _VisionAnyCallProvider(LLMProvider):
    """Returns the same scripted response for any vision_extract call."""

    def __init__(
        self,
        response: dict[str, Any] | None = None,
        *,
        usage: TokenUsage | None = None,
    ) -> None:
        self.response = response or _canonical_vision_response()
        self.usage: TokenUsage = usage if usage is not None else _stub_usage()
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
        return dict(self.response), self.usage


class _VisionFailingProvider(LLMProvider):
    """Vision-only failing provider."""

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


def _build_client(provider: LLMProvider) -> TestClient:
    app = create_app()
    app.dependency_overrides[get_llm_provider] = lambda: provider
    return TestClient(app)


# ─────────────────────────────────────────────────────────────────────
# Happy paths
# ─────────────────────────────────────────────────────────────────────


def test_post_extract_photos_returns_200_for_single_photo() -> None:
    """1 photo → 200 + recipe. source_url pinned to the photos sentinel."""
    provider = _VisionAnyCallProvider()
    client = _build_client(provider)
    response = client.post(
        "/extract/photos",
        json={
            "photo_urls": ["https://example.com/photo-1.jpg"],
            "hint": {"group_id": "g1", "user_id": "u1"},
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["recipe"]["title"] == "Omas Apfelkuchen"
    # LLM's fabricated URL was overridden.
    assert body["recipe"]["source_url"] == "photos://upload"
    # The multi-ingredient confidence bag contains the
    # handwritten_uncertain flag, unchanged.
    confidences = {i["confidence"] for i in body["recipe"]["ingredients"]}
    assert "handwritten_uncertain" in confidences
    assert provider.calls == 1


def test_post_extract_photos_multi_photo() -> None:
    """3 photos → 200, single vision call, result carries the recipe."""
    provider = _VisionAnyCallProvider()
    client = _build_client(provider)
    response = client.post(
        "/extract/photos",
        json={
            "photo_urls": [
                "https://example.com/photo-1.jpg",
                "https://example.com/photo-2.jpg",
                "https://example.com/photo-3.jpg",
            ],
            "hint": {"group_id": "g1", "user_id": "u1"},
        },
    )
    assert response.status_code == 200
    assert provider.calls == 1


# ─────────────────────────────────────────────────────────────────────
# Input validation — pydantic layer (HTTP 422)
# ─────────────────────────────────────────────────────────────────────


def test_post_extract_photos_rejects_missing_body() -> None:
    app = create_app()
    client = TestClient(app)
    response = client.post("/extract/photos", json={})
    assert response.status_code == 422


def test_post_extract_photos_rejects_missing_hint() -> None:
    """``hint`` is required — mirror the /extract/url contract."""
    app = create_app()
    client = TestClient(app)
    response = client.post(
        "/extract/photos",
        json={"photo_urls": ["https://example.com/a.jpg"]},
    )
    assert response.status_code == 422


def test_post_extract_photos_rejects_non_http_url_at_pydantic_layer() -> None:
    """``HttpUrl`` at the pydantic layer catches non-http schemes."""
    app = create_app()
    client = TestClient(app)
    response = client.post(
        "/extract/photos",
        json={
            "photo_urls": ["ftp://example.com/a.jpg"],
            "hint": {"group_id": "g", "user_id": "u"},
        },
    )
    assert response.status_code == 422


# ─────────────────────────────────────────────────────────────────────
# Input validation — pipeline layer (HTTP 422 via ExtractionError)
# ─────────────────────────────────────────────────────────────────────


def test_post_extract_photos_rejects_empty_list() -> None:
    """Zero photos → 422 with a German message."""
    provider = _VisionAnyCallProvider()
    client = _build_client(provider)
    response = client.post(
        "/extract/photos",
        json={
            "photo_urls": [],
            "hint": {"group_id": "g", "user_id": "u"},
        },
    )
    assert response.status_code == 422
    assert "Foto" in response.json()["detail"]
    assert provider.calls == 0


def test_post_extract_photos_rejects_eleven_photos() -> None:
    """11 photos → 422 with the 'maximal 10' message."""
    provider = _VisionAnyCallProvider()
    client = _build_client(provider)
    urls = [f"https://example.com/p-{i}.jpg" for i in range(11)]
    response = client.post(
        "/extract/photos",
        json={
            "photo_urls": urls,
            "hint": {"group_id": "g", "user_id": "u"},
        },
    )
    assert response.status_code == 422
    assert "10" in response.json()["detail"]
    assert provider.calls == 0


# ─────────────────────────────────────────────────────────────────────
# Provider errors
# ─────────────────────────────────────────────────────────────────────


def test_post_extract_photos_returns_503_on_provider_unavailable() -> None:
    """Azure outage → LLMProviderError(provider_unavailable) → HTTP 503."""
    provider = _VisionFailingProvider(
        LLMProviderError("Azure 503", code="provider_unavailable"),
    )
    client = _build_client(provider)
    response = client.post(
        "/extract/photos",
        json={
            "photo_urls": ["https://example.com/a.jpg"],
            "hint": {"group_id": "g", "user_id": "u"},
        },
    )
    assert response.status_code == 503
    assert "KI-Service" in response.json()["detail"]


def test_post_extract_photos_returns_503_on_rate_limit() -> None:
    """Azure 429 → LLMProviderError(rate_limited) → HTTP 503."""
    provider = _VisionFailingProvider(
        LLMProviderError("throttled", code="rate_limited"),
    )
    client = _build_client(provider)
    response = client.post(
        "/extract/photos",
        json={
            "photo_urls": ["https://example.com/a.jpg"],
            "hint": {"group_id": "g", "user_id": "u"},
        },
    )
    assert response.status_code == 503


def test_post_extract_photos_returns_500_on_schema_mismatch() -> None:
    """Malformed LLM reply surfaces as a generic 500 — a service bug,
    not a caller bug, and the caller can't do anything with specifics."""
    provider = _VisionFailingProvider(
        LLMProviderError("bad shape", code="schema_mismatch"),
    )
    client = _build_client(provider)
    response = client.post(
        "/extract/photos",
        json={
            "photo_urls": ["https://example.com/a.jpg"],
            "hint": {"group_id": "g", "user_id": "u"},
        },
    )
    assert response.status_code == 500


def test_post_extract_photos_uses_dependency_override_for_provider() -> None:
    """Sanity: the ``get_llm_provider`` override is actually consulted —
    if the default (``build_provider(Settings())``) ran, we would hit
    the Azure network."""
    provider = _VisionAnyCallProvider()
    client = _build_client(provider)
    client.post(
        "/extract/photos",
        json={
            "photo_urls": ["https://example.com/a.jpg"],
            "hint": {"group_id": "g", "user_id": "u"},
        },
    )
    assert provider.calls == 1
