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

from extractor.llm import LLMProvider, LLMProviderError, TokenUsage
from extractor.main import create_app, get_llm_provider, get_video_stack
from extractor.pipeline.video import (
    ExtractionError,
    FrameExtractor,
    StubDownloader,
    StubFrameExtractor,
    StubTranscriber,
    ThumbnailCandidate,
    Transcriber,
    VideoAssets,
    VideoDownloader,
    YtDlpThumbnail,
)


def _canonical_response() -> dict[str, Any]:
    """COMP-1: ingredients + steps live inside a single default component."""
    return {
        "title": "Lachsfilet",
        "description": None,
        "servings": 2,
        "difficulty": None,
        "prep_minutes": 5,
        "cook_minutes": 12,
        "components": [
            {
                "label": None,
                "position": 0,
                "ingredients": [
                    {
                        "name": "Lachs",
                        "quantity": "400",
                        "unit": "g",
                        "note": None,
                        "confidence": "high",
                    }
                ],
                "steps": [
                    {"position": 1, "content": "Ofen vorheizen.", "confidence": "high"},
                ],
            }
        ],
        "tags": ["fisch"],
        "source_url": "https://llm.example",
    }


def _stub_usage() -> TokenUsage:
    return {
        "prompt_tokens": 400,
        "completion_tokens": 120,
        "cached_prompt_tokens": 0,
        "model": "gpt-4.1-mini",
    }


class _AnyCallProvider(LLMProvider):
    """Returns the same scripted response for any call."""

    def __init__(
        self,
        response: dict[str, Any] | None = None,
        *,
        usage: TokenUsage | None = None,
    ) -> None:
        self.response = response or _canonical_response()
        self.usage: TokenUsage = usage if usage is not None else _stub_usage()
        self.calls = 0

    async def extract_structured(
        self, system_prompt: str, messages: Any, json_schema: dict[str, Any]
    ) -> tuple[dict[str, Any], TokenUsage]:
        self.calls += 1
        return dict(self.response), self.usage

    async def chat(self, system_prompt: str, messages: Any) -> tuple[str, TokenUsage]:
        raise NotImplementedError

    async def vision_extract(
        self,
        system_prompt: str,
        images: Any,
        instruction: str,
        json_schema: dict[str, Any],
    ) -> tuple[dict[str, Any], TokenUsage]:
        raise NotImplementedError


class _FailingProvider(LLMProvider):
    def __init__(self, error: LLMProviderError) -> None:
        self.error = error

    async def extract_structured(
        self, system_prompt: str, messages: Any, json_schema: dict[str, Any]
    ) -> tuple[dict[str, Any], TokenUsage]:
        raise self.error

    async def chat(self, system_prompt: str, messages: Any) -> tuple[str, TokenUsage]:
        raise self.error

    async def vision_extract(
        self,
        system_prompt: str,
        images: Any,
        instruction: str,
        json_schema: dict[str, Any],
    ) -> tuple[dict[str, Any], TokenUsage]:
        raise self.error


def _video_stack_factory(
    downloader: VideoDownloader,
    transcriber: Transcriber,
    frame_extractor: FrameExtractor | None = None,
) -> object:
    """Build the tuple returned by the ``get_video_stack`` dependency.

    COVER-0 slice A — tests that exercise the video path supply a
    :class:`StubFrameExtractor` so no real ffmpeg shells out.
    """
    from extractor.main import VideoStack

    return VideoStack(
        downloader=downloader,
        transcriber=transcriber,
        frame_extractor=frame_extractor or StubFrameExtractor(frames=[]),
    )


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
    # PF2 — the .NET job reads these headers off the response to
    # record usage on the RecipeImport row.
    assert response.headers["x-extractor-prompt-tokens"] == "400"
    assert response.headers["x-extractor-completion-tokens"] == "120"
    assert response.headers["x-extractor-cached-tokens"] == "0"
    assert response.headers["x-extractor-model"] == "gpt-4.1-mini"


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


# ─────────────────────────────────────────────────────────────────────
# PV2 security — SSRF allowlist + UUID pattern on callback fields
# ─────────────────────────────────────────────────────────────────────


def test_post_extract_url_rejects_callback_url_outside_allowlist(app_client: TestClient) -> None:
    """A callback_url host that isn't the docker-internal ``api`` must be
    rejected with 422 at request-parse — the SSRF defence prevents an
    attacker with a valid HMAC signature from steering the per-import
    bearer token at ``169.254.169.254`` or an attacker-controlled host."""
    response = app_client.post(
        "/extract/url",
        json={
            "url": "https://youtu.be/abc",
            "hint": {"group_id": "g1", "user_id": "u1"},
            "callback_url": "http://169.254.169.254/latest/meta-data/",
            "callback_token": "tok",
            "import_id": "11111111-2222-3333-4444-555555555555",
        },
    )
    assert response.status_code == 422


def test_post_extract_url_rejects_attacker_host(app_client: TestClient) -> None:
    """Any non-allowlisted host must be rejected, including attacker-hosted
    public domains."""
    response = app_client.post(
        "/extract/url",
        json={
            "url": "https://youtu.be/abc",
            "hint": {"group_id": "g1", "user_id": "u1"},
            "callback_url": "https://attacker.evil/steal",
            "callback_token": "tok",
            "import_id": "11111111-2222-3333-4444-555555555555",
        },
    )
    assert response.status_code == 422


def test_post_extract_url_accepts_allowlisted_callback(
    app_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The default allowlist host ``api`` is accepted; a different host
    can be configured via the PROGRESS_CALLBACK_HOST env var."""
    monkeypatch.setenv("PROGRESS_CALLBACK_HOST", "api")
    response = app_client.post(
        "/extract/url",
        json={
            "url": "https://youtu.be/abc",
            "hint": {"group_id": "g1", "user_id": "u1"},
            "callback_url": "http://api/api/internal/imports/x/progress",
            "callback_token": "tok",
            "import_id": "11111111-2222-3333-4444-555555555555",
            "attempt": 1,
        },
    )
    # Reporter never actually fires during the request because the
    # stubbed video path + any-call provider return fast; what we
    # assert here is that the pydantic validator *accepts* the shape
    # so the pipeline runs end-to-end and returns 200.
    assert response.status_code == 200


def test_post_extract_url_rejects_malformed_import_id(app_client: TestClient) -> None:
    """A non-UUID ``import_id`` must be rejected at request parse so it
    can never reach the logger or a downstream callback URL."""
    response = app_client.post(
        "/extract/url",
        json={
            "url": "https://youtu.be/abc",
            "hint": {"group_id": "g1", "user_id": "u1"},
            "import_id": "not-a-uuid",
        },
    )
    assert response.status_code == 422


def test_post_extract_url_accepts_valid_uuid_import_id(app_client: TestClient) -> None:
    """A correctly-shaped UUID passes validation."""
    response = app_client.post(
        "/extract/url",
        json={
            "url": "https://youtu.be/abc",
            "hint": {"group_id": "g1", "user_id": "u1"},
            "import_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        },
    )
    assert response.status_code == 200


# ─────────────────────────────────────────────────────────────────────
# COVER-0 — candidate_thumbnails on the wire
# ─────────────────────────────────────────────────────────────────────


def test_post_extract_url_surfaces_candidate_thumbnails_on_video(
    tmp_path: Path,
) -> None:
    """End-to-end: the /extract/url endpoint returns
    ``recipe.candidate_thumbnails`` carrying top-2 yt-dlp + ffmpeg
    frames in extractor-emit order."""
    app = create_app()
    mp4 = tmp_path / "video.mp4"
    mp4.write_bytes(b"stub")
    downloader = StubDownloader(
        assets=VideoAssets(
            mp4_path=mp4,
            title="Reel",
            description="",
            thumbnail_url="https://cdn.example/poster.jpg",
            candidate_thumbnails=(
                YtDlpThumbnail(url="https://cdn.example/hi.jpg", width=1280, timestamp=None),
                YtDlpThumbnail(url="https://cdn.example/mid.jpg", width=720, timestamp=None),
            ),
            duration_seconds=20.0,
        )
    )
    transcriber = StubTranscriber(transcript="")
    frame_extractor = StubFrameExtractor(
        frames=[
            ThumbnailCandidate(url="file:///tmp/f0.jpg", timestamp=3.0),
            ThumbnailCandidate(url="file:///tmp/f1.jpg", timestamp=7.0),
        ]
    )
    provider = _AnyCallProvider()

    app.dependency_overrides[get_llm_provider] = lambda: provider
    app.dependency_overrides[get_video_stack] = lambda: _video_stack_factory(
        downloader, transcriber, frame_extractor
    )
    client = TestClient(app)
    response = client.post(
        "/extract/url",
        json={
            "url": "https://youtu.be/abc",
            "hint": {"group_id": "g1", "user_id": "u1"},
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["recipe"]["candidate_thumbnails"] == [
        "https://cdn.example/hi.jpg",
        "https://cdn.example/mid.jpg",
        "file:///tmp/f0.jpg",
        "file:///tmp/f1.jpg",
    ]
    # COVER-0 cleanup — ``thumbnail_url`` is no longer on the wire.
    assert "thumbnail_url" not in body["recipe"]
