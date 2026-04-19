"""Tests for :func:`extract_from_url` — the top-level pipeline glue."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import httpx
import pytest
import respx

from extractor.llm import LLMProvider, LLMProviderError, MockLLMProvider, TokenUsage
from extractor.llm.mock import make_script_key
from extractor.pipeline.types import ExtractionResult
from extractor.pipeline.url import (
    _find_first_external_url,
    classify_url,
    extract_from_url,
)
from extractor.pipeline.video import (
    ExtractionError,
    StubDownloader,
    StubTranscriber,
    VideoAssets,
)
from extractor.prompts.recipe_extraction import (
    SYSTEM_PROMPT_DE,
    build_user_message,
)


def _canonical_llm_response() -> dict[str, Any]:
    """A clean LLM reply matching RECIPE_SCHEMA."""
    return {
        "title": "Testrezept",
        "description": "Ein Test.",
        "servings": 4,
        "difficulty": 2,
        "prep_minutes": 10,
        "cook_minutes": 20,
        "ingredients": [
            {
                "name": "Mehl",
                "quantity": "250",
                "unit": "g",
                "note": None,
                "confidence": "high",
            }
        ],
        "steps": [{"position": 1, "content": "Mehl abwiegen.", "confidence": "high"}],
        "tags": ["test"],
        "source_url": "https://llm.example/bogus",
        "thumbnail_url": None,
    }


def _script_mock_for(
    *,
    transcript: str | None,
    caption: str | None,
    blog_text: str | None,
    thumbnail: str | None,
    response: dict[str, Any],
) -> MockLLMProvider:
    """Build a MockLLMProvider primed to answer our exact prompt."""
    user_message = build_user_message(
        transcript=transcript,
        caption=caption,
        blog_text=blog_text,
        thumbnail_url=thumbnail,
    )
    key = make_script_key(
        system_prompt=SYSTEM_PROMPT_DE,
        messages=[{"role": "user", "content": user_message}],
    )
    return MockLLMProvider(scripted={key: response})


# ─────────────────────────────────────────────────────────────────────
# URL classifier
# ─────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "url",
    [
        "https://www.youtube.com/watch?v=abc",
        "https://youtu.be/abc",
        "https://www.facebook.com/share/r/xyz",
        "https://www.instagram.com/reel/abc/",
        "https://www.tiktok.com/@u/video/12345",
    ],
)
def test_classify_video_urls(url: str) -> None:
    """Known video hosts classify as 'video'."""
    assert classify_url(url) == "video"


@pytest.mark.parametrize(
    "url",
    [
        "https://www.chefkoch.de/rezepte/linsen",
        "https://example.com/rezept",
        "https://my-food-blog.example/post/42",
    ],
)
def test_classify_blog_urls(url: str) -> None:
    """Everything not in the video host list is 'blog'."""
    assert classify_url(url) == "blog"


# ─────────────────────────────────────────────────────────────────────
# Blog path (with respx mocking httpx GET)
# ─────────────────────────────────────────────────────────────────────


@respx.mock
async def test_extract_from_blog_url_with_jsonld(tmp_path: Path) -> None:
    """Happy path: blog URL with JSON-LD flows through the LLM and post-process."""
    fixture = (Path(__file__).parent / "fixtures" / "blog" / "jsonld_spaghetti.html").read_text(
        encoding="utf-8"
    )
    respx.get("https://example.com/spaghetti").mock(return_value=httpx.Response(200, text=fixture))

    # The blog path uses extract_jsonld + extract_bs4_fallback.
    # For this test, we don't care which layer won — we feed the LLM
    # mock the composed blog_text + thumbnail and check the response.
    # Rather than deduce the exact text, we use a provider that accepts
    # any call by using a wrapper.

    mock = _AnyCallMock(_canonical_llm_response())

    result: ExtractionResult = await extract_from_url(
        "https://example.com/spaghetti",
        provider=mock,
    )
    assert result["recipe"]["source_url"] == "https://example.com/spaghetti"
    assert result["recipe"]["title"] == "Testrezept"
    assert mock.calls == 1


@respx.mock
async def test_extract_from_blog_url_surfaces_fetch_failure_note(tmp_path: Path) -> None:
    """When the blog fetch returns 404, the pipeline still completes (no
    video-only sources here), but adds the 'Website nicht erreichbar'
    note."""
    respx.get("https://example.com/broken").mock(return_value=httpx.Response(404))

    mock = _AnyCallMock(_canonical_llm_response())
    result = await extract_from_url("https://example.com/broken", provider=mock)
    assert "Website nicht erreichbar" in result["confidence"]["notes"]


# ─────────────────────────────────────────────────────────────────────
# Video path (with StubDownloader + StubTranscriber)
# ─────────────────────────────────────────────────────────────────────


async def test_extract_from_url_attaches_usage_to_result(tmp_path: Path) -> None:
    """PF2: the LLM usage flows through to the ExtractionResult so the
    HTTP layer can emit ``X-Extractor-*`` headers end-to-end."""
    mp4 = tmp_path / "video.mp4"
    mp4.write_bytes(b"stub")
    downloader = StubDownloader(
        assets=VideoAssets(
            mp4_path=mp4,
            title="Nudelauflauf",
            description="",
            thumbnail_url=None,
        )
    )
    transcriber = StubTranscriber(transcript="Mehl.")

    mock = _AnyCallMock(_canonical_llm_response())
    result = await extract_from_url(
        "https://youtu.be/abc",
        provider=mock,
        downloader=downloader,
        transcriber=transcriber,
    )
    assert "usage" in result
    usage = result["usage"]
    # _AnyCallMock hardcodes _stub_usage() — any non-zero prompt count
    # proves the propagation path is wired end-to-end.
    assert usage["prompt_tokens"] == 100
    assert usage["completion_tokens"] == 25
    assert usage["model"] == "gpt-4.1-mini"


async def test_extract_from_video_url_happy_path(tmp_path: Path) -> None:
    """yt-dlp + whisper stubs feed the LLM; post-process returns a result."""
    mp4 = tmp_path / "video.mp4"
    mp4.write_bytes(b"stub")
    downloader = StubDownloader(
        assets=VideoAssets(
            mp4_path=mp4,
            title="Nudelauflauf",
            description="Leckerer Auflauf",
            thumbnail_url="https://example.com/thumb.jpg",
        )
    )
    transcriber = StubTranscriber(transcript="Mehl, Wasser, Salz.")

    mock = _script_mock_for(
        transcript="Mehl, Wasser, Salz.",
        caption="Leckerer Auflauf",
        blog_text=None,
        thumbnail="https://example.com/thumb.jpg",
        response=_canonical_llm_response(),
    )

    result = await extract_from_url(
        "https://youtu.be/abc",
        provider=mock,
        downloader=downloader,
        transcriber=transcriber,
    )
    assert result["recipe"]["source_url"] == "https://youtu.be/abc"
    # Thumbnail falls back to the yt-dlp one since the LLM returned None.
    assert result["recipe"]["thumbnail_url"] == "https://example.com/thumb.jpg"


async def test_extract_from_video_url_private_raises_source_unavailable(
    tmp_path: Path,
) -> None:
    """yt-dlp DownloadError → ExtractionError(source_unavailable) bubbles."""
    downloader = StubDownloader(
        error=ExtractionError(
            "source_unavailable",
            "Das Video ist nicht verfügbar.",
        )
    )
    with pytest.raises(ExtractionError) as exc_info:
        await extract_from_url(
            "https://youtu.be/private",
            provider=MockLLMProvider(),
            downloader=downloader,
            transcriber=StubTranscriber(),
        )
    assert exc_info.value.code == "source_unavailable"


async def test_extract_from_video_url_llm_unavailable_bubbles(tmp_path: Path) -> None:
    """Azure 5xx → LLMProviderError(provider_unavailable) propagates
    so the HTTP layer can surface HTTP 503."""
    mp4 = tmp_path / "video.mp4"
    mp4.write_bytes(b"")
    downloader = StubDownloader(
        assets=VideoAssets(
            mp4_path=mp4,
            title="t",
            description="d",
            thumbnail_url=None,
        )
    )
    transcriber = StubTranscriber(transcript="x")
    provider = _FailingProvider(LLMProviderError("Azure 503", code="provider_unavailable"))

    with pytest.raises(LLMProviderError) as exc_info:
        await extract_from_url(
            "https://youtu.be/x",
            provider=provider,
            downloader=downloader,
            transcriber=transcriber,
        )
    assert exc_info.value.code == "provider_unavailable"


async def test_extract_flags_missing_quantities_end_to_end(tmp_path: Path) -> None:
    """An LLM reply with quantity=None arrives at the client as
    confidence='missing' (post-process flag)."""
    mp4 = tmp_path / "video.mp4"
    mp4.write_bytes(b"")
    downloader = StubDownloader(
        assets=VideoAssets(
            mp4_path=mp4,
            title="t",
            description="",
            thumbnail_url=None,
        )
    )
    transcriber = StubTranscriber(transcript="x")

    response = _canonical_llm_response()
    response["ingredients"] = [
        {
            "name": "Prise Salz",
            "quantity": None,
            "unit": None,
            "note": None,
            "confidence": "high",  # LLM claimed high; post-process overrides
        }
    ]
    mock = _script_mock_for(
        transcript="x",
        caption=None,
        blog_text=None,
        thumbnail=None,
        response=response,
    )

    result = await extract_from_url(
        "https://youtu.be/x",
        provider=mock,
        downloader=downloader,
        transcriber=transcriber,
    )
    assert result["recipe"]["ingredients"][0]["confidence"] == "missing"


# ─────────────────────────────────────────────────────────────────────
# P2-2.1 — Caption-URL-Follow
# ─────────────────────────────────────────────────────────────────────


def test_find_first_external_url_returns_none_for_empty_caption() -> None:
    """Empty / None captions must not trigger a fetch."""
    assert _find_first_external_url(None, source_url="https://www.facebook.com/reel/1") is None
    assert _find_first_external_url("", source_url="https://www.facebook.com/reel/1") is None


def test_find_first_external_url_skips_same_host() -> None:
    """URLs to the same host as the source must be ignored (no re-crawl)."""
    caption = "Schaut das Original: https://www.facebook.com/somepage/posts/1 — viel Spaß!"
    assert _find_first_external_url(caption, source_url="https://www.facebook.com/reel/1") is None


def test_find_first_external_url_skips_video_hosts() -> None:
    """Known video hosts (TikTok, Insta, YouTube) must not be followed."""
    caption = "Mein TikTok: https://www.tiktok.com/@u/video/12345"
    assert _find_first_external_url(caption, source_url="https://www.facebook.com/reel/1") is None


def test_find_first_external_url_skips_shorteners() -> None:
    """Known shortener hosts must be ignored — we can't filter their redirects."""
    caption = "Full recipe: https://bit.ly/abcdef"
    assert _find_first_external_url(caption, source_url="https://www.facebook.com/reel/1") is None


def test_find_first_external_url_picks_first_external() -> None:
    """When a caption contains both skipped and valid URLs, return the first valid one."""
    caption = (
        "Repost: https://www.facebook.com/somepage/posts/1 "
        "Rezept: https://blog.example/gochujang-noodles"
    )
    assert (
        _find_first_external_url(caption, source_url="https://www.facebook.com/reel/1")
        == "https://blog.example/gochujang-noodles"
    )


def test_find_first_external_url_trims_trailing_punctuation() -> None:
    """Prose punctuation (., ,, ;, :, !, ?) must not leak into the URL."""
    caption = "Rezept: https://blog.example/recipe."
    assert (
        _find_first_external_url(caption, source_url="https://www.facebook.com/reel/1")
        == "https://blog.example/recipe"
    )


@respx.mock
async def test_extract_from_url_fetches_caption_linked_blog(tmp_path: Path) -> None:
    """When a FB video caption references an external recipe blog, the
    pipeline fetches it and hands ``blog_text`` to the LLM alongside
    transcript + caption."""
    fixture = (Path(__file__).parent / "fixtures" / "blog" / "jsonld_spaghetti.html").read_text(
        encoding="utf-8"
    )
    respx.get("https://blog.example/carbonara").mock(return_value=httpx.Response(200, text=fixture))

    mp4 = tmp_path / "video.mp4"
    mp4.write_bytes(b"stub")
    caption = "Full recipe on my blog: https://blog.example/carbonara"
    downloader = StubDownloader(
        assets=VideoAssets(
            mp4_path=mp4,
            title="Carbonara Reel",
            description=caption,
            thumbnail_url=None,
        )
    )
    transcriber = StubTranscriber(transcript="Speck und Ei.")

    mock = _CapturingMock(_canonical_llm_response())
    result = await extract_from_url(
        "https://www.facebook.com/share/r/xyz",
        provider=mock,
        downloader=downloader,
        transcriber=transcriber,
    )

    # The LLM user message must contain the labelled blog section.
    assert mock.last_messages is not None
    user_content = mock.last_messages[0]["content"]
    assert "Blog-Webseite (Text):" in user_content
    assert "Spaghetti Carbonara" in user_content
    # Transcript + caption still feed the LLM in parallel.
    assert "Speck und Ei." in user_content
    assert caption in user_content
    # og:image from the blog becomes the fallback thumbnail.
    assert result["recipe"]["thumbnail_url"] == "https://example.com/images/carbonara.jpg"


@respx.mock
async def test_extract_from_url_tolerates_failed_caption_blog_fetch(
    tmp_path: Path,
) -> None:
    """If the caption-linked blog returns 5xx, the pipeline still runs
    on transcript+caption alone and adds a warning note."""
    respx.get("https://blog.example/dead").mock(return_value=httpx.Response(500))

    mp4 = tmp_path / "video.mp4"
    mp4.write_bytes(b"stub")
    caption = "Rezept: https://blog.example/dead"
    downloader = StubDownloader(
        assets=VideoAssets(
            mp4_path=mp4,
            title="Reel",
            description=caption,
            thumbnail_url="https://example.com/thumb.jpg",
        )
    )
    transcriber = StubTranscriber(transcript="Zutaten: Salz.")

    mock = _CapturingMock(_canonical_llm_response())
    result = await extract_from_url(
        "https://www.facebook.com/share/r/xyz",
        provider=mock,
        downloader=downloader,
        transcriber=transcriber,
    )

    # Pipeline completed.
    assert result["recipe"]["source_url"] == "https://www.facebook.com/share/r/xyz"
    # Warning surfaced.
    assert "Website nicht erreichbar" in result["confidence"]["notes"]
    # Transcript + caption still reached the LLM, no blog_text.
    assert mock.last_messages is not None
    user_content = mock.last_messages[0]["content"]
    assert "Zutaten: Salz." in user_content
    assert caption in user_content
    assert "Blog-Webseite (Text):" not in user_content


# ─────────────────────────────────────────────────────────────────────
# Test helpers
# ─────────────────────────────────────────────────────────────────────


def _stub_usage() -> TokenUsage:
    return {
        "prompt_tokens": 100,
        "completion_tokens": 25,
        "cached_prompt_tokens": 0,
        "model": "gpt-4.1-mini",
    }


class _AnyCallMock(LLMProvider):
    """Returns the scripted response for any prompt; counts calls."""

    def __init__(self, response: dict[str, Any]) -> None:
        self._response = response
        self.calls = 0

    async def extract_structured(
        self, system_prompt: str, messages: Any, json_schema: dict[str, Any]
    ) -> tuple[dict[str, Any], TokenUsage]:
        self.calls += 1
        return dict(self._response), _stub_usage()

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


class _CapturingMock(LLMProvider):
    """Returns a scripted response and stores the last ``messages`` list.

    Used by the caption-URL-follow tests to assert that ``blog_text``
    reaches the LLM without asserting on the exact composed prompt
    (which makes tests brittle).
    """

    def __init__(self, response: dict[str, Any]) -> None:
        self._response = response
        self.last_messages: list[dict[str, Any]] | None = None

    async def extract_structured(
        self, system_prompt: str, messages: Any, json_schema: dict[str, Any]
    ) -> tuple[dict[str, Any], TokenUsage]:
        self.last_messages = list(messages)
        return dict(self._response), _stub_usage()

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
    """Always raises the supplied error."""

    def __init__(self, error: LLMProviderError) -> None:
        self._error = error

    async def extract_structured(
        self, system_prompt: str, messages: Any, json_schema: dict[str, Any]
    ) -> tuple[dict[str, Any], TokenUsage]:
        raise self._error

    async def chat(self, system_prompt: str, messages: Any) -> tuple[str, TokenUsage]:
        raise self._error

    async def vision_extract(
        self,
        system_prompt: str,
        images: Any,
        instruction: str,
        json_schema: dict[str, Any],
    ) -> tuple[dict[str, Any], TokenUsage]:
        raise self._error


# Silence unused-import-for-typeing warnings.
_ = Awaitable, Callable
