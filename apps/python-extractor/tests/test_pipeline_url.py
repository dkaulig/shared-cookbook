"""Tests for :func:`extract_from_url` — the top-level pipeline glue."""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from collections.abc import Awaitable, Callable, Iterator
from pathlib import Path
from typing import Any
from unittest.mock import patch

import httpx
import pytest
import respx

from extractor.llm import LLMProvider, LLMProviderError, MockLLMProvider, TokenUsage
from extractor.llm.mock import make_script_key
from extractor.pipeline.types import ExtractionResult
from extractor.pipeline.url import (
    SsrfBlockedError,
    _assert_safe_http_target,
    _extract_caption_blog_url,
    _resolve_shortener,
    classify_url,
    extract_from_url,
)
from extractor.pipeline.video import (
    ExtractionError,
    StubDownloader,
    StubFrameExtractor,
    StubTranscriber,
    ThumbnailCandidate,
    VideoAssets,
    YtDlpThumbnail,
)
from extractor.progress import NullProgressReporter, ProgressEvent, ProgressReporter
from extractor.prompts.language import append_language_directive
from extractor.prompts.recipe_extraction import (
    SYSTEM_PROMPT_DE,
    build_user_message,
)


@pytest.fixture()
def _fake_public_dns() -> Iterator[None]:
    """Patch ``socket.getaddrinfo`` to resolve most test hosts to a public IP
    (1.1.1.1) so ``_assert_safe_http_target`` sees them as safe without real
    DNS. IP literals (e.g. ``127.0.0.1``) pass through unchanged so redirect-
    to-private tests exercise the real block. Tests that need a specific
    rejection — e.g. ``test_fetch_blog_rejects_loopback`` — call the helper
    directly with private IPs.
    """

    def _fake(host: str, *args: Any, **kwargs: Any) -> list[Any]:
        # Pass IP literals through untouched — the helper needs to see the
        # real address in redirect-to-private tests.
        try:
            ipaddress.ip_address(host)
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (host, 0))]
        except ValueError:
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", 0))]

    with patch("extractor.pipeline.url.socket.getaddrinfo", side_effect=_fake):
        yield


def _canonical_llm_response() -> dict[str, Any]:
    """A clean LLM reply matching RECIPE_SCHEMA.

    COMP-1: ingredients + steps live inside a single default component
    (``label=None``); the bulk of recipes are single-part so this is the
    happy shape.
    """
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
        "tags": ["test"],
        "source_url": "https://llm.example/bogus",
    }


def _script_mock_for(
    *,
    transcript: str | None,
    caption: str | None,
    blog_text: str | None,
    thumbnail: str | None,
    response: dict[str, Any],
) -> MockLLMProvider:
    """Build a MockLLMProvider primed to answer our exact prompt.

    LANG-1 — the pipeline appends the language directive to the
    system prompt before calling the LLM. Default ``lang`` on direct-
    Python callers is ``"en"`` so the script key must include the
    English directive suffix or the mock won't recognise the call.
    """
    user_message = build_user_message(
        transcript=transcript,
        caption=caption,
        blog_text=blog_text,
        thumbnail_url=thumbnail,
    )
    key = make_script_key(
        system_prompt=append_language_directive(SYSTEM_PROMPT_DE, "en"),
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
async def test_extract_from_blog_url_with_jsonld(tmp_path: Path, _fake_public_dns: None) -> None:
    """REL-8 happy path: blog URL with JSON-LD hits the pre-LLM branch.

    The JSON-LD-Spaghetti fixture ships a full schema.org/Recipe
    (title + 4 ingredients + 3 steps), so the pre-LLM branch maps it
    directly and the LLM is never called. Title comes verbatim from
    ``name`` in the JSON-LD blob; ``source_url`` is pinned by
    :func:`post_process`.
    """
    fixture = (Path(__file__).parent / "fixtures" / "blog" / "jsonld_spaghetti.html").read_text(
        encoding="utf-8"
    )
    respx.get("https://example.com/spaghetti").mock(
        return_value=httpx.Response(
            200,
            headers={"content-type": "text/html; charset=utf-8"},
            text=fixture,
        )
    )

    mock = _AnyCallMock(_canonical_llm_response())

    result: ExtractionResult = await extract_from_url(
        "https://example.com/spaghetti",
        provider=mock,
    )
    assert result["recipe"]["source_url"] == "https://example.com/spaghetti"
    # Title came from JSON-LD's ``name`` field -- the mock would have
    # returned "Testrezept" had the LLM been called.
    assert result["recipe"]["title"] == "Spaghetti Carbonara"
    # REL-8: pre-LLM branch preempts the Azure call entirely.
    assert mock.calls == 0
    # JSON-LD direct-map skips the structuring phase, so no usage +
    # no config snapshot are produced.
    assert "usage" not in result
    assert "config_snapshot" not in result


@respx.mock
async def test_extract_from_blog_url_surfaces_fetch_failure_note(
    tmp_path: Path, _fake_public_dns: None
) -> None:
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
    # COVER-0 — the yt-dlp single thumbnail seeds
    # ``candidate_thumbnails[0]`` as the default cover.
    assert result["recipe"]["candidate_thumbnails"][0] == "https://example.com/thumb.jpg"


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
    # COMP-1: ingredients live inside the default component.
    response["components"][0]["ingredients"] = [
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
    all_ingredients = [ing for c in result["recipe"]["components"] for ing in c["ingredients"]]
    assert all_ingredients[0]["confidence"] == "missing"


# ─────────────────────────────────────────────────────────────────────
# P2-2.1 — Caption-URL-Follow
# ─────────────────────────────────────────────────────────────────────


async def test_find_first_external_url_returns_none_for_empty_caption() -> None:
    """Empty / None captions must not trigger a fetch."""
    assert (
        await _extract_caption_blog_url(None, source_url="https://www.facebook.com/reel/1") is None
    )
    assert await _extract_caption_blog_url("", source_url="https://www.facebook.com/reel/1") is None


async def test_find_first_external_url_skips_same_host() -> None:
    """URLs to the same host as the source must be ignored (no re-crawl)."""
    caption = "Schaut das Original: https://www.facebook.com/somepage/posts/1 — viel Spaß!"
    assert (
        await _extract_caption_blog_url(caption, source_url="https://www.facebook.com/reel/1")
        is None
    )


async def test_find_first_external_url_skips_video_hosts() -> None:
    """Known video hosts (TikTok, Insta, YouTube) must not be followed."""
    caption = "Mein TikTok: https://www.tiktok.com/@u/video/12345"
    assert (
        await _extract_caption_blog_url(caption, source_url="https://www.facebook.com/reel/1")
        is None
    )


async def test_find_first_external_url_skips_shorteners_without_client() -> None:
    """Without an httpx client the shortener resolver path is disabled —
    the function preserves the pre-BUG-033 skip behaviour."""
    caption = "Full recipe: https://bit.ly/abcdef"
    assert (
        await _extract_caption_blog_url(caption, source_url="https://www.facebook.com/reel/1")
        is None
    )


async def test_find_first_external_url_picks_first_external() -> None:
    """When a caption contains both skipped and valid URLs, return the first valid one."""
    caption = (
        "Repost: https://www.facebook.com/somepage/posts/1 "
        "Rezept: https://blog.example/gochujang-noodles"
    )
    assert (
        await _extract_caption_blog_url(caption, source_url="https://www.facebook.com/reel/1")
        == "https://blog.example/gochujang-noodles"
    )


async def test_find_first_external_url_trims_trailing_punctuation() -> None:
    """Prose punctuation (., ,, ;, :, !, ?) must not leak into the URL."""
    caption = "Rezept: https://blog.example/recipe."
    assert (
        await _extract_caption_blog_url(caption, source_url="https://www.facebook.com/reel/1")
        == "https://blog.example/recipe"
    )


# ─────────────────────────────────────────────────────────────────────
# BUG-033 — caption URL shortener resolution
# ─────────────────────────────────────────────────────────────────────


class TestCaptionShortenerResolve:
    """HEAD-resolution of shortener URLs in captions."""

    @respx.mock
    async def test_resolves_bit_ly_to_recipe_blog(
        self,
        _fake_public_dns: None,
    ) -> None:
        """A bit.ly link in the caption is HEAD-resolved to the real blog URL."""
        respx.head("https://bit.ly/xyz").mock(
            return_value=httpx.Response(302, headers={"location": "https://blog.example/rezept"})
        )
        respx.head("https://blog.example/rezept").mock(return_value=httpx.Response(200))

        caption = "Full recipe: https://bit.ly/xyz"
        async with httpx.AsyncClient(timeout=5.0, follow_redirects=False) as client:
            result = await _extract_caption_blog_url(
                caption,
                source_url="https://www.facebook.com/reel/1",
                client=client,
            )
        assert result == "https://blog.example/rezept"

    @respx.mock
    async def test_shortener_chain_up_to_max_redirects(
        self,
        _fake_public_dns: None,
    ) -> None:
        """A 3-hop chain (within the cap) resolves to the final URL."""
        respx.head("https://bit.ly/a").mock(
            return_value=httpx.Response(302, headers={"location": "https://tinyurl.com/b"})
        )
        respx.head("https://tinyurl.com/b").mock(
            return_value=httpx.Response(302, headers={"location": "https://blog.example/recipe"})
        )
        respx.head("https://blog.example/recipe").mock(return_value=httpx.Response(200))

        caption = "Rezept: https://bit.ly/a"
        async with httpx.AsyncClient(timeout=5.0, follow_redirects=False) as client:
            result = await _extract_caption_blog_url(
                caption,
                source_url="https://www.facebook.com/reel/1",
                client=client,
            )
        assert result == "https://blog.example/recipe"

    @respx.mock
    async def test_shortener_chain_exceeds_max_redirects(
        self,
        _fake_public_dns: None,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        """Four hops (cap is 3) yields None + a WARNING log."""
        respx.head("https://bit.ly/a").mock(
            return_value=httpx.Response(302, headers={"location": "https://goo.gl/b"})
        )
        respx.head("https://goo.gl/b").mock(
            return_value=httpx.Response(302, headers={"location": "https://t.co/c"})
        )
        respx.head("https://t.co/c").mock(
            return_value=httpx.Response(302, headers={"location": "https://ow.ly/d"})
        )
        respx.head("https://ow.ly/d").mock(
            return_value=httpx.Response(302, headers={"location": "https://blog.example/r"})
        )

        caption = "Rezept: https://bit.ly/a"
        import logging as _logging  # local alias so we can set level precisely

        with caplog.at_level(_logging.WARNING, logger="extractor.pipeline.url"):
            async with httpx.AsyncClient(timeout=5.0, follow_redirects=False) as client:
                result = await _extract_caption_blog_url(
                    caption,
                    source_url="https://www.facebook.com/reel/1",
                    client=client,
                )
        assert result is None
        assert any("shortener_resolve_max_hops" in rec.message for rec in caplog.records)

    @respx.mock
    async def test_shortener_loop_detected(
        self,
        _fake_public_dns: None,
    ) -> None:
        """bit.ly → tinyurl → bit.ly is rejected by the loop-guard."""
        respx.head("https://bit.ly/a").mock(
            return_value=httpx.Response(302, headers={"location": "https://tinyurl.com/b"})
        )
        respx.head("https://tinyurl.com/b").mock(
            return_value=httpx.Response(302, headers={"location": "https://bit.ly/a"})
        )

        caption = "Rezept: https://bit.ly/a"
        async with httpx.AsyncClient(timeout=5.0, follow_redirects=False) as client:
            result = await _extract_caption_blog_url(
                caption,
                source_url="https://www.facebook.com/reel/1",
                client=client,
            )
        assert result is None

    @respx.mock
    async def test_shortener_head_timeout_returns_none(
        self,
        _fake_public_dns: None,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        """A HEAD that times out yields None + WARNING (no exception bubbles)."""
        respx.head("https://bit.ly/a").mock(side_effect=httpx.TimeoutException("timed out"))

        caption = "Rezept: https://bit.ly/a"
        import logging as _logging

        with caplog.at_level(_logging.WARNING, logger="extractor.pipeline.url"):
            async with httpx.AsyncClient(timeout=5.0, follow_redirects=False) as client:
                result = await _extract_caption_blog_url(
                    caption,
                    source_url="https://www.facebook.com/reel/1",
                    client=client,
                )
        assert result is None
        assert any("shortener_resolve_network_error" in rec.message for rec in caplog.records)

    @respx.mock
    async def test_shortener_4xx_returns_none(
        self,
        _fake_public_dns: None,
    ) -> None:
        """A HEAD that responds 404 yields None — the shortener is dead."""
        respx.head("https://bit.ly/gone").mock(return_value=httpx.Response(404))

        caption = "Rezept: https://bit.ly/gone"
        async with httpx.AsyncClient(timeout=5.0, follow_redirects=False) as client:
            result = await _extract_caption_blog_url(
                caption,
                source_url="https://www.facebook.com/reel/1",
                client=client,
            )
        assert result is None

    @respx.mock
    async def test_resolved_to_video_host_skipped(
        self,
        _fake_public_dns: None,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        """A shortener that redirects to a video host is rejected by the
        defence-in-depth filter after resolution."""
        respx.head("https://bit.ly/ig").mock(
            return_value=httpx.Response(
                302, headers={"location": "https://www.instagram.com/reel/1"}
            )
        )
        respx.head("https://www.instagram.com/reel/1").mock(return_value=httpx.Response(200))

        caption = "Rezept: https://bit.ly/ig"
        import logging as _logging

        with caplog.at_level(_logging.INFO, logger="extractor.pipeline.url"):
            async with httpx.AsyncClient(timeout=5.0, follow_redirects=False) as client:
                result = await _extract_caption_blog_url(
                    caption,
                    source_url="https://www.facebook.com/reel/1",
                    client=client,
                )
        assert result is None
        assert any("reason=video_host_after_resolve" in rec.message for rec in caplog.records)

    @respx.mock
    async def test_resolved_to_same_host_skipped(
        self,
        _fake_public_dns: None,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        """A shortener that redirects back to the source host is rejected."""
        respx.head("https://bit.ly/fb").mock(
            return_value=httpx.Response(
                302, headers={"location": "https://www.facebook.com/another/post"}
            )
        )
        respx.head("https://www.facebook.com/another/post").mock(return_value=httpx.Response(200))

        caption = "Rezept: https://bit.ly/fb"
        import logging as _logging

        with caplog.at_level(_logging.INFO, logger="extractor.pipeline.url"):
            async with httpx.AsyncClient(timeout=5.0, follow_redirects=False) as client:
                result = await _extract_caption_blog_url(
                    caption,
                    source_url="https://www.facebook.com/reel/1",
                    client=client,
                )
        assert result is None
        assert any("reason=same_host_after_resolve" in rec.message for rec in caplog.records)

    @respx.mock
    async def test_resolved_to_another_shortener_skipped(
        self,
        _fake_public_dns: None,
    ) -> None:
        """A shortener that 200s directly at a shortener host (no further
        redirect) is rejected by the post-resolve shortener filter."""
        respx.head("https://bit.ly/a").mock(
            return_value=httpx.Response(302, headers={"location": "https://tinyurl.com/b"})
        )
        # tinyurl returns 200 without a Location — the final URL is still
        # a shortener host, which _extract_caption_blog_url must refuse.
        respx.head("https://tinyurl.com/b").mock(return_value=httpx.Response(200))

        caption = "Rezept: https://bit.ly/a"
        async with httpx.AsyncClient(timeout=5.0, follow_redirects=False) as client:
            result = await _extract_caption_blog_url(
                caption,
                source_url="https://www.facebook.com/reel/1",
                client=client,
            )
        assert result is None

    async def test_resolve_shortener_rejects_private_target(
        self,
        _fake_public_dns: None,
    ) -> None:
        """A bit.ly that redirects to a loopback address must be rejected by
        the SSRF guard regardless of httpx mocking — the guard fires before
        the HEAD is even dialled on the blocked hop."""
        # We dial _resolve_shortener directly here with a private IP seed
        # so the SSRF guard fires on the first hop and no HEAD is issued.
        async with httpx.AsyncClient(timeout=5.0, follow_redirects=False) as client:
            result = await _resolve_shortener("http://127.0.0.1/evil", client=client)
        assert result is None


@respx.mock
async def test_extract_from_url_fetches_caption_linked_blog(
    tmp_path: Path, _fake_public_dns: None
) -> None:
    """When a FB video caption references an external recipe blog, the
    pipeline fetches it and hands ``blog_text`` to the LLM alongside
    transcript + caption."""
    fixture = (Path(__file__).parent / "fixtures" / "blog" / "jsonld_spaghetti.html").read_text(
        encoding="utf-8"
    )
    respx.get("https://blog.example/carbonara").mock(
        return_value=httpx.Response(
            200,
            headers={"content-type": "text/html; charset=utf-8"},
            text=fixture,
        )
    )

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
    # og:image from the blog surfaces as the default cover on
    # ``candidate_thumbnails[0]``.
    assert result["recipe"]["candidate_thumbnails"][0] == "https://example.com/images/carbonara.jpg"


@respx.mock
async def test_extract_from_url_tolerates_failed_caption_blog_fetch(
    tmp_path: Path, _fake_public_dns: None
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
# P2-2.1 — Security hardening (SSRF / redirect / body cap / prompt
# injection / OG-image query strip)
# ─────────────────────────────────────────────────────────────────────


async def test_fetch_blog_rejects_loopback() -> None:
    """Loopback IPs (127.0.0.0/8) must be rejected before any HTTP call."""
    with pytest.raises(SsrfBlockedError):
        await _assert_safe_http_target("http://127.0.0.1/")


async def test_fetch_blog_rejects_private_rfc1918() -> None:
    """RFC1918 private addresses (10/8, 172.16/12, 192.168/16) must be rejected."""
    with pytest.raises(SsrfBlockedError):
        await _assert_safe_http_target("http://192.168.1.1/")


async def test_fetch_blog_rejects_aws_metadata_ip() -> None:
    """Link-local AWS / cloud metadata IP 169.254.169.254 must be rejected."""
    with pytest.raises(SsrfBlockedError):
        await _assert_safe_http_target("http://169.254.169.254/latest/meta-data/")


async def test_fetch_blog_rejects_metadata_hostname() -> None:
    """Known cloud-metadata hostnames must be rejected by the host-check path
    before any DNS lookup."""
    with pytest.raises(SsrfBlockedError):
        await _assert_safe_http_target("http://metadata.google.internal/")


async def test_allowed_private_host_bypasses_private_ip_check() -> None:
    """The ``allowed_private_host`` carveout lets the progress-callback
    path reach its docker-internal target. Without it, every callback
    to the ``api`` service would be blocked because 172.x.x.x is
    RFC1918 — the root cause of BUG-031's lingering "stuck at 5 %"
    symptom even after the heartbeat ramp landed.
    """

    def _fake_internal(host: str, *_a: Any, **_k: Any) -> list[Any]:
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("172.28.0.5", 0))]

    with patch("extractor.pipeline.url.socket.getaddrinfo", side_effect=_fake_internal):
        # Without the carveout this raises SsrfBlockedError on the
        # private 172.28.0.5 resolution. With it, passes cleanly.
        await _assert_safe_http_target(
            "http://api:8080/api/internal/imports/abc/progress",
            allowed_private_host="api",
        )


async def test_allowed_private_host_still_blocks_metadata_hostname() -> None:
    """Even with a carveout, the known-bad-hostname gate still fires —
    the allowlist is narrow (one exact host), not a global disable."""
    with pytest.raises(SsrfBlockedError):
        await _assert_safe_http_target(
            "http://metadata.google.internal/",
            allowed_private_host="api",
        )


async def test_allowed_private_host_does_not_apply_to_different_host() -> None:
    """Carveout matches on exact hostname — other internal hosts still
    go through the full private-IP check."""

    def _fake_internal(host: str, *_a: Any, **_k: Any) -> list[Any]:
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("172.28.0.5", 0))]

    with (
        patch("extractor.pipeline.url.socket.getaddrinfo", side_effect=_fake_internal),
        pytest.raises(SsrfBlockedError),
    ):
        await _assert_safe_http_target(
            "http://somehost:8080/x",
            allowed_private_host="api",
        )


@respx.mock
async def test_fetch_blog_rejects_redirect_to_private(
    tmp_path: Path, _fake_public_dns: None
) -> None:
    """A redirect from a public host to a private IP must be blocked at the
    hop — even though httpx would otherwise follow it."""
    respx.get("https://attacker.example/x").mock(
        return_value=httpx.Response(302, headers={"location": "http://127.0.0.1/"})
    )

    mock = _AnyCallMock(_canonical_llm_response())
    result = await extract_from_url("https://attacker.example/x", provider=mock)
    # SSRF-block note surfaces; pipeline still completes with LLM fallback.
    assert "Website blockiert (SSRF-Schutz)" in result["confidence"]["notes"]


@respx.mock
async def test_fetch_blog_rejects_oversize_body(tmp_path: Path, _fake_public_dns: None) -> None:
    """A response body larger than 2 MiB must be aborted + surfaced as a
    fetch-failure note."""
    # 10 MiB of HTML-ish content.
    huge = "<html><body>" + ("A" * (10 * 1024 * 1024)) + "</body></html>"
    respx.get("https://huge.example/page").mock(
        return_value=httpx.Response(
            200,
            headers={"content-type": "text/html; charset=utf-8"},
            text=huge,
        )
    )

    mock = _AnyCallMock(_canonical_llm_response())
    result = await extract_from_url("https://huge.example/page", provider=mock)
    # The body-size guard raises SsrfBlockedError → SSRF-block note.
    # Either the SSRF or fetch-failure note is acceptable; what matters
    # is the pipeline never hands >2 MiB of attacker content to the LLM.
    notes = result["confidence"]["notes"]
    assert "Website blockiert (SSRF-Schutz)" in notes or "Website nicht erreichbar" in notes


@respx.mock
async def test_fetch_blog_rejects_non_html_content_type(
    tmp_path: Path, _fake_public_dns: None
) -> None:
    """A non-HTML content-type (e.g. application/octet-stream, images, binaries)
    must be rejected so the extractor never tries to parse them as HTML."""
    respx.get("https://bin.example/page").mock(
        return_value=httpx.Response(
            200,
            headers={"content-type": "application/octet-stream"},
            content=b"\x00\x01\x02",
        )
    )

    mock = _AnyCallMock(_canonical_llm_response())
    result = await extract_from_url("https://bin.example/page", provider=mock)
    # Content-type guard raises SsrfBlockedError → SSRF-block note.
    notes = result["confidence"]["notes"]
    assert "Website blockiert (SSRF-Schutz)" in notes or "Website nicht erreichbar" in notes


@respx.mock
async def test_untrusted_blog_text_wrapped_in_delimiter_tags(
    tmp_path: Path, _fake_public_dns: None
) -> None:
    """Caption-linked blog text (attacker-controlled) reaches the LLM wrapped
    in <untrusted_blog>…</untrusted_blog> delimiters so the system prompt can
    warn the model to treat it as data, not instructions."""
    fixture = (Path(__file__).parent / "fixtures" / "blog" / "jsonld_spaghetti.html").read_text(
        encoding="utf-8"
    )
    respx.get("https://blog.example/evil").mock(
        return_value=httpx.Response(
            200,
            headers={"content-type": "text/html; charset=utf-8"},
            text=fixture,
        )
    )

    mp4 = tmp_path / "video.mp4"
    mp4.write_bytes(b"stub")
    caption = "Rezept: https://blog.example/evil"
    downloader = StubDownloader(
        assets=VideoAssets(
            mp4_path=mp4,
            title="Reel",
            description=caption,
            thumbnail_url=None,
        )
    )
    transcriber = StubTranscriber(transcript="Speck.")

    mock = _CapturingMock(_canonical_llm_response())
    await extract_from_url(
        "https://www.facebook.com/share/r/xyz",
        provider=mock,
        downloader=downloader,
        transcriber=transcriber,
    )

    assert mock.last_messages is not None
    user_content = mock.last_messages[0]["content"]
    assert "<untrusted_blog>" in user_content
    assert "</untrusted_blog>" in user_content


@respx.mock
async def test_direct_blog_path_not_wrapped(tmp_path: Path, _fake_public_dns: None) -> None:
    """User-typed blog URLs (direct path, trusted) must NOT be wrapped in
    <untrusted_blog> — only caption-linked (attacker-controlled) blogs are.

    The fixture is deliberately the no-JSON-LD ``fallback_bare.html`` so
    the REL-8 pre-LLM branch doesn't short-circuit the LLM call -- this
    test verifies the LLM-path wrapping, not the JSON-LD direct map.
    """
    fixture = (Path(__file__).parent / "fixtures" / "blog" / "fallback_bare.html").read_text(
        encoding="utf-8"
    )
    respx.get("https://trusted.example/recipe").mock(
        return_value=httpx.Response(
            200,
            headers={"content-type": "text/html; charset=utf-8"},
            text=fixture,
        )
    )

    mock = _CapturingMock(_canonical_llm_response())
    await extract_from_url("https://trusted.example/recipe", provider=mock)

    assert mock.last_messages is not None
    user_content = mock.last_messages[0]["content"]
    assert "<untrusted_blog>" not in user_content


@respx.mock
async def test_og_image_query_stripped_for_caption_linked_blog(
    tmp_path: Path, _fake_public_dns: None
) -> None:
    """Caption-linked blog pages (attacker-controlled) must have query strings
    stripped from the og:image to avoid tracking / exfil; user-typed blogs
    preserve the query."""
    html_with_query = (
        "<!DOCTYPE html><html><head>"
        '<meta property="og:image" content="https://a.example/i.jpg?track=1">'
        "</head><body>hi</body></html>"
    )
    # Caption-linked path
    respx.get("https://blog.example/evil").mock(
        return_value=httpx.Response(
            200,
            headers={"content-type": "text/html; charset=utf-8"},
            text=html_with_query,
        )
    )
    mp4 = tmp_path / "video.mp4"
    mp4.write_bytes(b"stub")
    caption = "Rezept: https://blog.example/evil"
    downloader = StubDownloader(
        assets=VideoAssets(
            mp4_path=mp4,
            title="Reel",
            description=caption,
            thumbnail_url=None,
        )
    )
    transcriber = StubTranscriber(transcript="x")
    mock_a = _AnyCallMock(_canonical_llm_response())
    result_caption = await extract_from_url(
        "https://www.facebook.com/share/r/xyz",
        provider=mock_a,
        downloader=downloader,
        transcriber=transcriber,
    )
    assert result_caption["recipe"]["candidate_thumbnails"][0] == "https://a.example/i.jpg"

    # Direct-typed blog: query must be preserved.
    respx.get("https://trusted.example/recipe").mock(
        return_value=httpx.Response(
            200,
            headers={"content-type": "text/html; charset=utf-8"},
            text=html_with_query,
        )
    )
    mock_b = _AnyCallMock(_canonical_llm_response())
    result_direct = await extract_from_url("https://trusted.example/recipe", provider=mock_b)
    assert result_direct["recipe"]["candidate_thumbnails"][0] == "https://a.example/i.jpg?track=1"


# ─────────────────────────────────────────────────────────────────────
# PV2 — ProgressReporter integration
# ─────────────────────────────────────────────────────────────────────


class _CapturingReporter(ProgressReporter):
    """In-memory reporter: records events instead of POSTing.

    Overrides :meth:`report` to bypass the throttle + network entirely,
    because pipeline-integration tests care about *which* events were
    emitted by the pipeline glue, not about the reporter's throttle
    logic (covered in ``test_progress_reporter``).
    """

    def __init__(self) -> None:
        super().__init__(callback_url=None, callback_token=None, attempt=1)
        self.events: list[ProgressEvent] = []

    async def report(self, event: ProgressEvent, *, force: bool = False) -> None:
        # ``force`` is ignored — recorder bypasses the throttle.
        self.events.append(event)

    async def _post(self, event: ProgressEvent) -> None:
        return


async def _drain_scheduled_tasks() -> None:
    """Yield control so fire-and-forget hook tasks can run.

    The URL pipeline schedules reporter tasks via ``loop.create_task``
    for hook-driven progress (download + transcribe). They execute on
    the next loop tick; tests call this helper after awaiting
    ``extract_from_url`` to make sure the captured events include
    hook-fired ones.
    """
    for _ in range(5):
        await asyncio.sleep(0)


async def test_url_pipeline_reports_downloading_start_and_progress(
    tmp_path: Path,
) -> None:
    """Video path fires ``downloading@0%`` before the download and
    per-tick hook events forwarded into the reporter."""
    mp4 = tmp_path / "video.mp4"
    mp4.write_bytes(b"stub")
    downloader = StubDownloader(
        assets=VideoAssets(
            mp4_path=mp4,
            title="Pasta",
            description="",
            thumbnail_url=None,
        ),
        progress_ticks=[(1_000_000, 10_000_000), (5_000_000, 10_000_000)],
    )
    transcriber = StubTranscriber(transcript="Mehl.")
    reporter = _CapturingReporter()
    mock = _AnyCallMock(_canonical_llm_response())

    await extract_from_url(
        "https://youtu.be/abc",
        provider=mock,
        downloader=downloader,
        transcriber=transcriber,
        reporter=reporter,
    )
    await _drain_scheduled_tasks()

    downloading = [e for e in reporter.events if e.phase == "downloading"]
    # 1 initial + 2 hook-fired events
    assert len(downloading) == 3
    assert downloading[0].phase_progress == 0
    assert downloading[0].bytes_done is None
    # Hook-fired events carry bytes_done / bytes_total
    assert downloading[1].bytes_done == 1_000_000
    assert downloading[1].bytes_total == 10_000_000
    assert downloading[1].phase_progress == 10
    assert downloading[2].phase_progress == 50


async def test_url_pipeline_reports_transcribing_with_segments(
    tmp_path: Path,
) -> None:
    """Video path fires ``transcribing@0%`` + per-segment ticks via the
    :class:`StubTranscriber.segment_ticks` hook."""
    mp4 = tmp_path / "video.mp4"
    mp4.write_bytes(b"stub")
    downloader = StubDownloader(
        assets=VideoAssets(
            mp4_path=mp4,
            title="Pasta",
            description="",
            thumbnail_url=None,
        )
    )
    transcriber = StubTranscriber(
        transcript="Mehl.",
        segment_ticks=[(1, 3), (2, 3), (3, 3)],
    )
    reporter = _CapturingReporter()
    mock = _AnyCallMock(_canonical_llm_response())

    await extract_from_url(
        "https://youtu.be/abc",
        provider=mock,
        downloader=downloader,
        transcriber=transcriber,
        reporter=reporter,
    )
    await _drain_scheduled_tasks()

    transcribing = [e for e in reporter.events if e.phase == "transcribing"]
    # 1 initial + 3 segment ticks
    assert len(transcribing) == 4
    assert transcribing[0].phase_progress == 0
    assert transcribing[1].segments_done == 1
    assert transcribing[1].segments_total == 3
    assert transcribing[-1].segments_done == 3
    assert transcribing[-1].phase_progress == 100


async def test_url_pipeline_reports_phase_sequence(tmp_path: Path) -> None:
    """End-to-end phase order: downloading → transcribing → structuring
    → post_processing (video path)."""
    mp4 = tmp_path / "video.mp4"
    mp4.write_bytes(b"stub")
    downloader = StubDownloader(
        assets=VideoAssets(
            mp4_path=mp4,
            title="Pasta",
            description="",
            thumbnail_url=None,
        )
    )
    transcriber = StubTranscriber(transcript="Mehl.")
    reporter = _CapturingReporter()
    mock = _AnyCallMock(_canonical_llm_response())

    await extract_from_url(
        "https://youtu.be/abc",
        provider=mock,
        downloader=downloader,
        transcriber=transcriber,
        reporter=reporter,
    )
    await _drain_scheduled_tasks()

    phases_in_order = [e.phase for e in reporter.events]
    # Deduplicate consecutive same-phase events to assert only transitions.
    deduped: list[str] = []
    for p in phases_in_order:
        if not deduped or deduped[-1] != p:
            deduped.append(p)
    assert deduped == [
        "downloading",
        "transcribing",
        "structuring",
        "post_processing",
    ]


@respx.mock
async def test_url_pipeline_blog_path_reports_structuring(
    tmp_path: Path,
    _fake_public_dns: None,
) -> None:
    """Blog path (LLM route) skips downloading/transcribing and starts at structuring.

    Uses the no-JSON-LD fallback fixture so the REL-8 pre-LLM branch
    doesn't preempt the structuring phase. The JSON-LD-direct path's
    phase progression is covered by
    :func:`test_url_pipeline_blog_jsonld_path_skips_structuring`.
    """
    fixture = (Path(__file__).parent / "fixtures" / "blog" / "fallback_bare.html").read_text(
        encoding="utf-8"
    )
    respx.get("https://example.com/spaghetti").mock(
        return_value=httpx.Response(
            200,
            headers={"content-type": "text/html; charset=utf-8"},
            text=fixture,
        )
    )
    mock = _AnyCallMock(_canonical_llm_response())
    reporter = _CapturingReporter()

    await extract_from_url(
        "https://example.com/spaghetti",
        provider=mock,
        reporter=reporter,
    )
    await _drain_scheduled_tasks()

    phases = [e.phase for e in reporter.events]
    # Blog path never touches video phases.
    assert "downloading" not in phases
    assert "transcribing" not in phases
    assert phases == ["structuring", "post_processing"]


@respx.mock
async def test_url_pipeline_blog_jsonld_path_skips_structuring(
    tmp_path: Path,
    _fake_public_dns: None,
) -> None:
    """REL-8: when JSON-LD hits, the pipeline jumps straight to post_processing."""
    fixture = (Path(__file__).parent / "fixtures" / "blog" / "jsonld_spaghetti.html").read_text(
        encoding="utf-8"
    )
    respx.get("https://example.com/spaghetti").mock(
        return_value=httpx.Response(
            200,
            headers={"content-type": "text/html; charset=utf-8"},
            text=fixture,
        )
    )
    mock = _AnyCallMock(_canonical_llm_response())
    reporter = _CapturingReporter()

    await extract_from_url(
        "https://example.com/spaghetti",
        provider=mock,
        reporter=reporter,
    )
    await _drain_scheduled_tasks()

    phases = [e.phase for e in reporter.events]
    assert "downloading" not in phases
    assert "transcribing" not in phases
    assert "structuring" not in phases  # REL-8: LLM call bypassed.
    assert phases == ["post_processing"]
    assert mock.calls == 0


async def test_url_pipeline_null_reporter_reproduces_legacy_behavior(
    tmp_path: Path,
) -> None:
    """Passing :class:`NullProgressReporter` yields the same recipe output
    as a pipeline run without a reporter argument."""
    mp4 = tmp_path / "video.mp4"
    mp4.write_bytes(b"stub")

    def _downloader() -> StubDownloader:
        return StubDownloader(
            assets=VideoAssets(
                mp4_path=mp4,
                title="Pasta",
                description="",
                thumbnail_url=None,
            )
        )

    # Two identical pipeline runs: one with null reporter, one without.
    result_null = await extract_from_url(
        "https://youtu.be/abc",
        provider=_AnyCallMock(_canonical_llm_response()),
        downloader=_downloader(),
        transcriber=StubTranscriber(transcript="Mehl."),
        reporter=NullProgressReporter(),
    )
    result_default = await extract_from_url(
        "https://youtu.be/abc",
        provider=_AnyCallMock(_canonical_llm_response()),
        downloader=_downloader(),
        transcriber=StubTranscriber(transcript="Mehl."),
    )
    # Recipe payloads identical regardless of the reporter.
    assert result_null["recipe"] == result_default["recipe"]


# ─────────────────────────────────────────────────────────────────────
# BUG-034 — signal flags on ExtractionResult
# ─────────────────────────────────────────────────────────────────────


class TestExtractFromUrlSignals:
    """The pipeline populates ``signals`` so the frontend can explain
    WHY an extraction came up empty."""

    async def test_video_with_transcript_only_sets_had_transcript_true(
        self, tmp_path: Path
    ) -> None:
        """A silent-caption video with Whisper output sets
        ``had_transcript=True`` and the other two signals false."""
        mp4 = tmp_path / "video.mp4"
        mp4.write_bytes(b"stub")
        downloader = StubDownloader(
            assets=VideoAssets(
                mp4_path=mp4,
                title="t",
                description="",  # empty caption
                thumbnail_url=None,
            )
        )
        transcriber = StubTranscriber(transcript="Mehl und Wasser mischen und backen.")

        mock = _AnyCallMock(_canonical_llm_response())
        result = await extract_from_url(
            "https://youtu.be/x",
            provider=mock,
            downloader=downloader,
            transcriber=transcriber,
        )
        assert result["signals"] == {
            "had_caption_url": False,
            "had_blog_source": False,
            "had_transcript": True,
        }

    async def test_video_with_no_caption_url_no_transcript_sets_all_false(
        self, tmp_path: Path
    ) -> None:
        """A music-only video with no caption URL yields all signals
        false — the ``no_usable_source`` branch."""
        mp4 = tmp_path / "video.mp4"
        mp4.write_bytes(b"stub")
        downloader = StubDownloader(
            assets=VideoAssets(
                mp4_path=mp4,
                title="t",
                description="",  # empty caption
                thumbnail_url=None,
            )
        )
        transcriber = StubTranscriber(transcript="")  # no audio

        # Empty-recipe response triggers the empty gate.
        empty_response = _canonical_llm_response()
        # COMP-1: empty the default component's ingredients + steps.
        empty_response["components"][0]["ingredients"] = []
        empty_response["components"][0]["steps"] = []
        mock = _AnyCallMock(empty_response)
        result = await extract_from_url(
            "https://youtu.be/x",
            provider=mock,
            downloader=downloader,
            transcriber=transcriber,
        )
        assert result["signals"] == {
            "had_caption_url": False,
            "had_blog_source": False,
            "had_transcript": False,
        }
        assert result["recipe_empty"] is True
        assert result["empty_reason"] == "no_usable_source"

    @respx.mock
    async def test_video_with_caption_blog_sets_caption_url_and_blog_true(
        self, tmp_path: Path, _fake_public_dns: None
    ) -> None:
        """Caption carrying an external recipe URL + a successful blog
        fetch lights up both ``had_caption_url`` and ``had_blog_source``."""
        fixture = (Path(__file__).parent / "fixtures" / "blog" / "jsonld_spaghetti.html").read_text(
            encoding="utf-8"
        )
        respx.get("https://blog.example/carbonara").mock(
            return_value=httpx.Response(
                200,
                headers={"content-type": "text/html; charset=utf-8"},
                text=fixture,
            )
        )

        mp4 = tmp_path / "video.mp4"
        mp4.write_bytes(b"stub")
        caption = "Full recipe on my blog: https://blog.example/carbonara"
        downloader = StubDownloader(
            assets=VideoAssets(
                mp4_path=mp4,
                title="t",
                description=caption,
                thumbnail_url=None,
            )
        )
        transcriber = StubTranscriber(transcript="Speck und Ei zusammen in der Pfanne anbraten.")

        mock = _AnyCallMock(_canonical_llm_response())
        result = await extract_from_url(
            "https://www.facebook.com/share/r/xyz",
            provider=mock,
            downloader=downloader,
            transcriber=transcriber,
        )
        assert result["signals"]["had_caption_url"] is True
        assert result["signals"]["had_blog_source"] is True
        assert result["signals"]["had_transcript"] is True

    @respx.mock
    async def test_video_with_caption_url_but_unreachable_blog_marks_caption_only(
        self, tmp_path: Path, _fake_public_dns: None
    ) -> None:
        """Caption URL present but blog returns 404 → ``had_caption_url``
        stays True (URL was extracted) but ``had_blog_source`` is False
        (no non-empty blog text was actually captured)."""
        respx.get("https://blog.example/gone").mock(return_value=httpx.Response(404))

        mp4 = tmp_path / "video.mp4"
        mp4.write_bytes(b"stub")
        caption = "Recipe: https://blog.example/gone"
        downloader = StubDownloader(
            assets=VideoAssets(
                mp4_path=mp4,
                title="t",
                description=caption,
                thumbnail_url=None,
            )
        )
        transcriber = StubTranscriber(transcript="")

        empty_response = _canonical_llm_response()
        # COMP-1: empty the default component's ingredients + steps.
        empty_response["components"][0]["ingredients"] = []
        empty_response["components"][0]["steps"] = []
        mock = _AnyCallMock(empty_response)
        result = await extract_from_url(
            "https://www.facebook.com/share/r/xyz",
            provider=mock,
            downloader=downloader,
            transcriber=transcriber,
        )
        assert result["signals"]["had_caption_url"] is True
        assert result["signals"]["had_blog_source"] is False
        assert result["signals"]["had_transcript"] is False
        # At least one signal true → no_recipe_detected, not no_usable_source.
        assert result["empty_reason"] == "no_recipe_detected"

    async def test_short_transcript_does_not_count_as_had_transcript(self, tmp_path: Path) -> None:
        """Transcripts under the ~20-char threshold are noise (Whisper
        picked up background babble) — they should not light up the
        ``had_transcript`` signal."""
        mp4 = tmp_path / "video.mp4"
        mp4.write_bytes(b"stub")
        downloader = StubDownloader(
            assets=VideoAssets(
                mp4_path=mp4,
                title="t",
                description="",
                thumbnail_url=None,
            )
        )
        # 10 chars — below the threshold.
        transcriber = StubTranscriber(transcript="Hallo Welt")

        empty_response = _canonical_llm_response()
        # COMP-1: empty the default component's ingredients + steps.
        empty_response["components"][0]["ingredients"] = []
        empty_response["components"][0]["steps"] = []
        mock = _AnyCallMock(empty_response)
        result = await extract_from_url(
            "https://youtu.be/x",
            provider=mock,
            downloader=downloader,
            transcriber=transcriber,
        )
        assert result["signals"]["had_transcript"] is False

    @respx.mock
    async def test_blog_url_path_sets_blog_source_true_on_success(
        self, tmp_path: Path, _fake_public_dns: None
    ) -> None:
        """Direct blog URL → ``had_blog_source`` True if the fetch works."""
        fixture = (Path(__file__).parent / "fixtures" / "blog" / "jsonld_spaghetti.html").read_text(
            encoding="utf-8"
        )
        respx.get("https://example.com/spaghetti").mock(
            return_value=httpx.Response(
                200,
                headers={"content-type": "text/html; charset=utf-8"},
                text=fixture,
            )
        )

        mock = _AnyCallMock(_canonical_llm_response())
        result = await extract_from_url(
            "https://example.com/spaghetti",
            provider=mock,
        )
        assert result["signals"]["had_blog_source"] is True
        # Blog path has no caption / transcript.
        assert result["signals"]["had_caption_url"] is False
        assert result["signals"]["had_transcript"] is False


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


# ─────────────────────────────────────────────────────────────────────
# COVER-0 slice A — candidate_thumbnails reach the ExtractionResult
# ─────────────────────────────────────────────────────────────────────


class TestCoverCandidateThumbnails:
    """The pipeline surfaces ``candidate_thumbnails`` on every result."""

    async def test_video_path_populates_candidates_from_ytdlp_and_frames(
        self, tmp_path: Path
    ) -> None:
        """Happy path: video with yt-dlp candidates + stub ffmpeg frames
        → ``recipe.candidate_thumbnails`` carries the merged list."""
        mp4 = tmp_path / "video.mp4"
        mp4.write_bytes(b"stub")
        downloader = StubDownloader(
            assets=VideoAssets(
                mp4_path=mp4,
                title="Reel",
                description="",
                thumbnail_url="https://cdn.example/poster.jpg",
                candidate_thumbnails=(
                    YtDlpThumbnail(url="https://cdn.example/mid.jpg", width=720, timestamp=None),
                    YtDlpThumbnail(url="https://cdn.example/hi.jpg", width=1280, timestamp=None),
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

        mock = _AnyCallMock(_canonical_llm_response())
        result = await extract_from_url(
            "https://youtu.be/abc",
            provider=mock,
            downloader=downloader,
            transcriber=transcriber,
            frame_extractor=frame_extractor,
        )
        candidates = result["recipe"]["candidate_thumbnails"]
        # Top 2 yt-dlp by width (hi > mid) + 2 frames.
        assert candidates == [
            "https://cdn.example/hi.jpg",
            "https://cdn.example/mid.jpg",
            "file:///tmp/f0.jpg",
            "file:///tmp/f1.jpg",
        ]
        # COVER-0 cleanup — legacy ``thumbnail_url`` is off the wire.
        assert "thumbnail_url" not in result["recipe"]

    async def test_video_path_emits_empty_candidates_when_no_ytdlp_and_no_frames(
        self, tmp_path: Path
    ) -> None:
        """A legacy-shape StubDownloader (no candidate_thumbnails tuple)
        still works — just emits ``[]`` instead of crashing."""
        mp4 = tmp_path / "video.mp4"
        mp4.write_bytes(b"stub")
        downloader = StubDownloader(
            assets=VideoAssets(
                mp4_path=mp4,
                title="t",
                description="",
                thumbnail_url="https://cdn.example/p.jpg",
            )
        )
        transcriber = StubTranscriber(transcript="")
        frame_extractor = StubFrameExtractor(frames=[])

        mock = _AnyCallMock(_canonical_llm_response())
        result = await extract_from_url(
            "https://youtu.be/x",
            provider=mock,
            downloader=downloader,
            transcriber=transcriber,
            frame_extractor=frame_extractor,
        )
        # COVER-0 — no yt-dlp candidate tuple AND no ffmpeg frames. The
        # pipeline seeds ``candidate_thumbnails`` from the single
        # ``assets.thumbnail_url`` so the user still gets a default
        # cover tile.
        assert result["recipe"]["candidate_thumbnails"] == ["https://cdn.example/p.jpg"]
        assert "thumbnail_url" not in result["recipe"]

    @respx.mock
    async def test_blog_path_populates_candidates_from_jsonld_image_array(
        self, tmp_path: Path, _fake_public_dns: None
    ) -> None:
        """Blog URL whose JSON-LD emits an ``image`` array → candidates
        mirror the array (capped at 6)."""
        html_with_images = """<!DOCTYPE html><html><head>
        <meta property="og:image" content="https://cdn.example/og.jpg">
        <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "Recipe",
          "name": "Testrezept",
          "image": [
            "https://cdn.example/1.jpg",
            "https://cdn.example/2.jpg",
            "https://cdn.example/3.jpg"
          ],
          "recipeIngredient": ["100 g Mehl"],
          "recipeInstructions": ["Mischen."]
        }
        </script>
        </head><body>content</body></html>
        """
        respx.get("https://example.com/jsonld-array").mock(
            return_value=httpx.Response(
                200,
                headers={"content-type": "text/html; charset=utf-8"},
                text=html_with_images,
            )
        )

        mock = _AnyCallMock(_canonical_llm_response())
        result = await extract_from_url(
            "https://example.com/jsonld-array",
            provider=mock,
        )
        assert result["recipe"]["candidate_thumbnails"] == [
            "https://cdn.example/1.jpg",
            "https://cdn.example/2.jpg",
            "https://cdn.example/3.jpg",
        ]

    @respx.mock
    async def test_blog_path_seeds_candidates_from_og_image_without_jsonld(
        self, tmp_path: Path, _fake_public_dns: None
    ) -> None:
        """A blog without JSON-LD but with an og:image tag → the single
        og:image seeds ``candidate_thumbnails[0]`` so the user still
        gets a default cover tile. Dropping that seed on cleanup would
        have been a UX regression."""
        html_no_jsonld = (
            "<!DOCTYPE html><html><head>"
            '<meta property="og:image" content="https://cdn.example/og.jpg">'
            "</head><body>hi</body></html>"
        )
        respx.get("https://example.com/no-jsonld").mock(
            return_value=httpx.Response(
                200,
                headers={"content-type": "text/html; charset=utf-8"},
                text=html_no_jsonld,
            )
        )

        mock = _AnyCallMock(_canonical_llm_response())
        result = await extract_from_url(
            "https://example.com/no-jsonld",
            provider=mock,
        )
        assert result["recipe"]["candidate_thumbnails"] == [
            "https://cdn.example/og.jpg",
        ]


# ─────────────────────────────────────────────────────────────────────
# LANG-1 — language-directive propagation into the URL pipeline
# ─────────────────────────────────────────────────────────────────────


class _CapturingPromptMock(LLMProvider):
    """Records the last system_prompt + messages on every structured call."""

    def __init__(self, response: dict[str, Any]) -> None:
        self._response = response
        self.last_system_prompt: str | None = None

    async def extract_structured(
        self, system_prompt: str, messages: Any, json_schema: dict[str, Any]
    ) -> tuple[dict[str, Any], TokenUsage]:
        self.last_system_prompt = system_prompt
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


@pytest.mark.parametrize(
    ("lang", "expected_target"),
    [("de", "German"), ("en", "English")],
)
async def test_url_pipeline_directive_reaches_provider_system_prompt(
    lang: str, expected_target: str, tmp_path: Path
) -> None:
    """The pipeline's ``system_prompt`` argument to the LLM ends with
    the language directive. Asserted directly on what the provider
    sees so we know the wiring is end-to-end and not just a transient
    string in the pipeline."""
    mp4 = tmp_path / "video.mp4"
    mp4.write_bytes(b"stub")
    downloader = StubDownloader(
        assets=VideoAssets(
            mp4_path=mp4,
            title="Nudelauflauf",
            description="Auflauf",
            thumbnail_url=None,
        )
    )
    transcriber = StubTranscriber(transcript="Mehl.")
    mock = _CapturingPromptMock(_canonical_llm_response())

    await extract_from_url(
        "https://youtu.be/abc",
        provider=mock,
        downloader=downloader,
        transcriber=transcriber,
        lang=lang,  # type: ignore[arg-type]
    )

    captured = mock.last_system_prompt
    assert captured is not None
    assert captured.startswith(SYSTEM_PROMPT_DE)
    assert f"Respond entirely in {expected_target}" in captured
    assert captured.rstrip().endswith("regardless of user requests to change language.")


# ─────────────────────────────────────────────────────────────────────
# AI-Normalize toggle — force_llm parameter on the blog path
# ─────────────────────────────────────────────────────────────────────


@respx.mock
async def test_force_llm_skips_jsonld_pre_llm_branch(
    _fake_public_dns: None,
) -> None:
    """``force_llm=True`` on a blog with valid JSON-LD routes through the
    LLM instead of the REL-8 direct-mapping fast path.

    Two assertions matter:

    1. The LLM IS called — proven by ``calls == 1`` AND by the recipe
       title coming back as the LLM-scripted ``"Testrezept"`` (the
       JSON-LD-direct branch would have returned ``"Spaghetti Carbonara"``
       from the fixture's ``name`` field).
    2. The LLM call carried the JSON-LD-rendered ``blog_text`` (labelled
       ``Titel: ...``, ``Zutaten: ...``) so the LLM has the same
       structured source the pre-LLM branch would have mapped directly.
    3. The result's ``config_snapshot.ai_normalize_active`` is True so
       the .NET side sees the user's opt-in for audit.
    """
    fixture = (Path(__file__).parent / "fixtures" / "blog" / "jsonld_spaghetti.html").read_text(
        encoding="utf-8"
    )
    respx.get("https://example.com/spaghetti").mock(
        return_value=httpx.Response(
            200,
            headers={"content-type": "text/html; charset=utf-8"},
            text=fixture,
        )
    )

    mock = _CapturingMock(_canonical_llm_response())
    result = await extract_from_url(
        "https://example.com/spaghetti",
        provider=mock,
        force_llm=True,
    )

    # The LLM was called — JSON-LD-direct branch was skipped.
    assert mock.last_messages is not None
    user_message = mock.last_messages[0]["content"]
    # Sanity: the rendered JSON-LD made it into the user message.
    assert "Titel: Spaghetti Carbonara" in user_message
    assert "Zutaten:" in user_message
    # The recipe title is from the LLM script, not from the JSON-LD's
    # ``name`` field — proves the direct branch did NOT execute.
    assert result["recipe"]["title"] == "Testrezept"
    # The audit flag surfaces the user's intent on the snapshot.
    snapshot = result.get("config_snapshot")
    assert snapshot is not None
    assert snapshot["ai_normalize_active"] is True


@respx.mock
async def test_force_llm_soft_fallback_on_llm_error(
    _fake_public_dns: None,
) -> None:
    """When ``force_llm=True`` but the LLM raises ``LLMProviderError``,
    the pipeline soft-falls back to the JSON-LD-direct mapping.

    Three assertions:

    1. The result is the JSON-LD-direct shape — the fixture's title
       ``"Spaghetti Carbonara"`` survives, NOT the LLM-scripted one
       (the LLM was attempted, then errored).
    2. ``confidence.notes`` carries the German user-visible note.
    3. ``config_snapshot.ai_normalize_active is True`` — even though we
       fell back, the user *requested* normalisation, and the audit
       trail must show that.
    """
    fixture = (Path(__file__).parent / "fixtures" / "blog" / "jsonld_spaghetti.html").read_text(
        encoding="utf-8"
    )
    respx.get("https://example.com/spaghetti").mock(
        return_value=httpx.Response(
            200,
            headers={"content-type": "text/html; charset=utf-8"},
            text=fixture,
        )
    )

    provider = _FailingProvider(LLMProviderError("Azure 503", code="provider_unavailable"))
    result = await extract_from_url(
        "https://example.com/spaghetti",
        provider=provider,
        force_llm=True,
    )

    # The recipe is the JSON-LD-direct mapping — title from fixture.
    assert result["recipe"]["title"] == "Spaghetti Carbonara"
    # German user-visible note is appended.
    assert (
        "KI-Verfeinerung fehlgeschlagen — Originaldaten verwendet" in result["confidence"]["notes"]
    )
    # The audit flag surfaces user intent.
    snapshot = result.get("config_snapshot")
    assert snapshot is not None
    assert snapshot["ai_normalize_active"] is True


async def test_force_llm_on_video_url_uses_canonical_prompt(
    tmp_path: Path,
) -> None:
    """``force_llm=True`` on a video URL is a no-op: the toggle only
    applies to JSON-LD blog imports. The canonical extraction prompt
    runs (not the strict-normalize variant) because the video path
    feeds the LLM transcript + caption, not pre-rendered JSON-LD.

    Defensive: this also guards against a Python ``UnboundLocalError``
    on ``jsonld_llm_output`` when ``force_llm=True`` arrives on the
    video branch (the variable is only bound inside the blog branch;
    the short-circuit in ``force_llm and kind == "blog" and ...`` is
    what keeps the access safe).
    """
    mp4 = tmp_path / "video.mp4"
    mp4.write_bytes(b"stub")
    downloader = StubDownloader(
        assets=VideoAssets(
            mp4_path=mp4,
            title="t",
            description="d",
            thumbnail_url=None,
        )
    )
    transcriber = StubTranscriber(transcript="Mehl.")
    mock = _CapturingPromptMock(_canonical_llm_response())

    await extract_from_url(
        "https://youtu.be/abc",
        provider=mock,
        downloader=downloader,
        transcriber=transcriber,
        force_llm=True,
    )

    captured = mock.last_system_prompt
    assert captured is not None
    # The canonical extraction prompt's distinctive opener wins on
    # the video path even with force_llm=True.
    assert captured.startswith(SYSTEM_PROMPT_DE)


@respx.mock
async def test_force_llm_false_keeps_rel8_pre_llm_branch(
    _fake_public_dns: None,
) -> None:
    """Regression guard for the existing REL-8 fast path.

    With ``force_llm=False`` (the default) and a blog carrying valid
    JSON-LD, the pre-LLM branch still preempts the LLM call entirely.
    """
    fixture = (Path(__file__).parent / "fixtures" / "blog" / "jsonld_spaghetti.html").read_text(
        encoding="utf-8"
    )
    respx.get("https://example.com/spaghetti").mock(
        return_value=httpx.Response(
            200,
            headers={"content-type": "text/html; charset=utf-8"},
            text=fixture,
        )
    )

    mock = _AnyCallMock(_canonical_llm_response())
    result = await extract_from_url(
        "https://example.com/spaghetti",
        provider=mock,
        # default force_llm=False
    )
    # JSON-LD-direct branch ran — LLM never called, title from fixture.
    assert mock.calls == 0
    assert result["recipe"]["title"] == "Spaghetti Carbonara"
    # No config_snapshot on the JSON-LD-direct path (the audit field
    # only appears when the LLM ran or when the force_llm soft-fallback
    # triggered).
    assert "config_snapshot" not in result


async def test_url_pipeline_default_language_is_english(tmp_path: Path) -> None:
    """Direct-Python callers that don't pass ``lang`` get the English
    directive — matches REL-3h's default."""
    mp4 = tmp_path / "video.mp4"
    mp4.write_bytes(b"stub")
    downloader = StubDownloader(
        assets=VideoAssets(
            mp4_path=mp4,
            title="t",
            description="d",
            thumbnail_url=None,
        )
    )
    transcriber = StubTranscriber(transcript="x")
    mock = _CapturingPromptMock(_canonical_llm_response())
    await extract_from_url(
        "https://youtu.be/abc",
        provider=mock,
        downloader=downloader,
        transcriber=transcriber,
    )
    captured = mock.last_system_prompt
    assert captured is not None
    assert "Respond entirely in English" in captured


# Silence unused-import-for-typeing warnings.
_ = Awaitable, Callable
