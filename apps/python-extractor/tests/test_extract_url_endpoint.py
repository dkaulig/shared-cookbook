"""Tests for the ``POST /extract/url`` endpoint.

All tests override the ``LLMProvider`` dependency to use a
:class:`MockLLMProvider` (or a custom fake) — no real Azure calls.
Real yt-dlp is shunted out via :class:`StubDownloader` +
:class:`StubTranscriber`.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from extractor.llm import LLMProvider, LLMProviderError
from extractor.main import create_app, get_llm_provider, get_video_stack
from extractor.pipeline.video import (
    ExtractionError,
    StubDownloader,
    StubTranscriber,
    Transcriber,
    VideoAssets,
    VideoDownloader,
)


def _canonical_response() -> dict[str, Any]:
    return {
        "title": "Lachsfilet",
        "description": None,
        "servings": 2,
        "difficulty": None,
        "prep_minutes": 5,
        "cook_minutes": 12,
        "ingredients": [
            {
                "name": "Lachs",
                "quantity": "400",
                "unit": "g",
                "note": None,
                "confidence": "high",
            }
        ],
        "steps": [{"position": 1, "content": "Ofen vorheizen.", "confidence": "high"}],
        "tags": ["fisch"],
        "source_url": "https://llm.example",
        "thumbnail_url": None,
    }


class _AnyCallProvider(LLMProvider):
    """Returns the same scripted response for any call."""

    def __init__(self, response: dict[str, Any] | None = None) -> None:
        self.response = response or _canonical_response()
        self.calls = 0

    async def extract_structured(
        self, system_prompt: str, messages: Any, json_schema: dict[str, Any]
    ) -> dict[str, Any]:
        self.calls += 1
        return dict(self.response)

    async def chat(self, system_prompt: str, messages: Any) -> str:
        raise NotImplementedError

    async def vision_extract(
        self,
        system_prompt: str,
        images: Any,
        instruction: str,
        json_schema: dict[str, Any],
    ) -> dict[str, Any]:
        raise NotImplementedError


class _FailingProvider(LLMProvider):
    def __init__(self, error: LLMProviderError) -> None:
        self.error = error

    async def extract_structured(
        self, system_prompt: str, messages: Any, json_schema: dict[str, Any]
    ) -> dict[str, Any]:
        raise self.error

    async def chat(self, system_prompt: str, messages: Any) -> str:
        raise self.error

    async def vision_extract(
        self,
        system_prompt: str,
        images: Any,
        instruction: str,
        json_schema: dict[str, Any],
    ) -> dict[str, Any]:
        raise self.error


def _video_stack_factory(downloader: VideoDownloader, transcriber: Transcriber) -> object:
    """Build the tuple returned by the ``get_video_stack`` dependency."""
    from extractor.main import VideoStack

    return VideoStack(downloader=downloader, transcriber=transcriber)


@pytest.fixture
def app_client(tmp_path: Path) -> TestClient:
    """A TestClient with dependency overrides wired for happy-path testing."""
    app = create_app()
    provider = _AnyCallProvider()

    mp4 = tmp_path / "video.mp4"
    mp4.write_bytes(b"stub")
    downloader = StubDownloader(
        assets=VideoAssets(
            mp4_path=mp4,
            title="Video",
            description="Beschreibung",
            thumbnail_url="https://example.com/thumb.jpg",
        )
    )
    transcriber = StubTranscriber(transcript="Lachs Ofen.")

    app.dependency_overrides[get_llm_provider] = lambda: provider
    app.dependency_overrides[get_video_stack] = lambda: _video_stack_factory(
        downloader, transcriber
    )
    return TestClient(app)


def test_post_extract_url_returns_200_for_video(app_client: TestClient) -> None:
    """Happy path: video URL flows through stubs + mock LLM → 200 + recipe."""
    response = app_client.post(
        "/extract/url",
        json={
            "url": "https://youtu.be/abc",
            "hint": {"group_id": "g1", "user_id": "u1"},
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["recipe"]["title"] == "Lachsfilet"
    assert body["recipe"]["source_url"] == "https://youtu.be/abc"
    assert body["confidence"]["overall"] == "high"


def test_post_extract_url_rejects_missing_url() -> None:
    """An empty body fails validation (HTTP 422)."""
    app = create_app()
    client = TestClient(app)
    response = client.post("/extract/url", json={})
    assert response.status_code == 422


def test_post_extract_url_rejects_non_http_url() -> None:
    """Schemes other than http/https are rejected at the endpoint."""
    app = create_app()
    client = TestClient(app)
    response = client.post(
        "/extract/url",
        json={"url": "ftp://example.com/x", "hint": {"group_id": "g", "user_id": "u"}},
    )
    assert response.status_code == 422


def test_post_extract_url_rejects_empty_url() -> None:
    """Empty string URL is rejected."""
    app = create_app()
    client = TestClient(app)
    response = client.post(
        "/extract/url",
        json={"url": "", "hint": {"group_id": "g", "user_id": "u"}},
    )
    assert response.status_code == 422


def test_post_extract_url_returns_503_on_provider_unavailable(tmp_path: Path) -> None:
    """Azure outage → LLMProviderError(provider_unavailable) → HTTP 503."""
    app = create_app()
    mp4 = tmp_path / "x.mp4"
    mp4.write_bytes(b"")
    downloader = StubDownloader(
        assets=VideoAssets(mp4_path=mp4, title="t", description="", thumbnail_url=None)
    )
    transcriber = StubTranscriber(transcript="x")
    failing = _FailingProvider(LLMProviderError("outage", code="provider_unavailable"))

    app.dependency_overrides[get_llm_provider] = lambda: failing
    app.dependency_overrides[get_video_stack] = lambda: _video_stack_factory(
        downloader, transcriber
    )
    client = TestClient(app)

    response = client.post(
        "/extract/url",
        json={
            "url": "https://youtu.be/x",
            "hint": {"group_id": "g", "user_id": "u"},
        },
    )
    assert response.status_code == 503
    body = response.json()
    assert "KI-Service" in body["detail"]


def test_post_extract_url_returns_422_on_source_unavailable(tmp_path: Path) -> None:
    """Private video → ExtractionError(source_unavailable) → HTTP 422."""
    app = create_app()
    downloader = StubDownloader(
        error=ExtractionError(
            "source_unavailable",
            "Das Video ist nicht verfügbar.",
        )
    )
    transcriber = StubTranscriber()
    provider = _AnyCallProvider()

    app.dependency_overrides[get_llm_provider] = lambda: provider
    app.dependency_overrides[get_video_stack] = lambda: _video_stack_factory(
        downloader, transcriber
    )
    client = TestClient(app)

    response = client.post(
        "/extract/url",
        json={
            "url": "https://youtu.be/private",
            "hint": {"group_id": "g", "user_id": "u"},
        },
    )
    assert response.status_code == 422
    assert "nicht verfügbar" in response.json()["detail"]


def test_post_extract_url_returns_401_on_auth_failure(tmp_path: Path) -> None:
    """Azure 401 → LLMProviderError(auth_failure) → HTTP 500 (service
    misconfig, surfaced to the caller as a generic server error)."""
    app = create_app()
    mp4 = tmp_path / "x.mp4"
    mp4.write_bytes(b"")
    downloader = StubDownloader(
        assets=VideoAssets(mp4_path=mp4, title="t", description="", thumbnail_url=None)
    )
    transcriber = StubTranscriber(transcript="x")
    failing = _FailingProvider(LLMProviderError("bad key", code="auth_failure"))

    app.dependency_overrides[get_llm_provider] = lambda: failing
    app.dependency_overrides[get_video_stack] = lambda: _video_stack_factory(
        downloader, transcriber
    )
    client = TestClient(app)
    response = client.post(
        "/extract/url",
        json={
            "url": "https://youtu.be/x",
            "hint": {"group_id": "g", "user_id": "u"},
        },
    )
    assert response.status_code == 500


@respx.mock
def test_post_extract_url_blog_path_success() -> None:
    """Blog URL end-to-end via the endpoint."""
    fixture = (Path(__file__).parent / "fixtures" / "blog" / "jsonld_spaghetti.html").read_text(
        encoding="utf-8"
    )
    respx.get("https://example.com/spag").mock(return_value=httpx.Response(200, text=fixture))

    app = create_app()
    provider = _AnyCallProvider()
    app.dependency_overrides[get_llm_provider] = lambda: provider
    client = TestClient(app)

    response = client.post(
        "/extract/url",
        json={
            "url": "https://example.com/spag",
            "hint": {"group_id": "g", "user_id": "u"},
        },
    )
    assert response.status_code == 200
    assert response.json()["recipe"]["source_url"] == "https://example.com/spag"
