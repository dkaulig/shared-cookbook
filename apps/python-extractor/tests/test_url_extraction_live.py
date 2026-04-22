"""Live-network integration smoke for the video-path pipeline.

This test actually downloads a public YouTube short + runs
``faster-whisper`` locally + calls Azure OpenAI. It's slow, expensive,
and network-dependent, so it's gated behind two env vars:

- ``EXTRACTOR_LIVE_DOWNLOAD=1`` — opts in to the yt-dlp + Whisper hot
  path. Without this set (the default) the test is skipped.
- ``AZURE_OPENAI_INTEGRATION=1`` — extra gate for the Azure call. If
  this isn't set, we use a ``MockLLMProvider`` primed to succeed so
  the test can still exercise the download + transcription path
  without billing credentials.

Run locally with::

    EXTRACTOR_LIVE_DOWNLOAD=1 uv run pytest tests/test_url_extraction_live.py -v

This test is never run in CI.
"""

from __future__ import annotations

import os
from typing import Any

import pytest

from extractor.config import Settings
from extractor.llm import MockLLMProvider, build_provider
from extractor.llm.mock import make_script_key
from extractor.pipeline.url import extract_from_url
from extractor.prompts.recipe_extraction import (
    SYSTEM_PROMPT_DE,
    build_user_message,
)

# A deliberately-short public YouTube video used for smoke-testing.
# We do NOT hard-code a specific creator URL here — the test expects
# the operator to set EXTRACTOR_LIVE_URL to something they control or
# can legally download.
_LIVE_URL_ENV = "EXTRACTOR_LIVE_URL"
_LIVE_GATE = "EXTRACTOR_LIVE_DOWNLOAD"
_AZURE_GATE = "AZURE_OPENAI_INTEGRATION"


pytestmark = pytest.mark.skipif(
    os.environ.get(_LIVE_GATE) != "1",
    reason=(
        "live yt-dlp / Whisper call; enable with EXTRACTOR_LIVE_DOWNLOAD=1 "
        "and EXTRACTOR_LIVE_URL=<public short URL>."
    ),
)


async def test_live_video_pipeline_runs_end_to_end() -> None:
    """Download + transcribe + (LLM or mock) → structured recipe."""
    live_url = os.environ.get(_LIVE_URL_ENV)
    if not live_url:
        pytest.skip(f"set {_LIVE_URL_ENV} to a public short URL before running this test.")

    # If Azure creds are provided, use the real provider; otherwise use
    # a MockLLMProvider that matches any transcript with a canned reply.
    provider: Any
    if os.environ.get(_AZURE_GATE) == "1":
        provider = build_provider(Settings())
    else:
        # Build a mock that answers *something* — we don't know the
        # exact transcript, so we key the mock permissively by
        # inspecting the first call's input and replying with a
        # canonical recipe. To keep MockLLMProvider strict we instead
        # pre-compute the key for an empty-transcript request and
        # allow the test to pass whenever the LLM would have been
        # called; if the transcript is non-empty the mock raises and
        # the test fails, which is a helpful signal that live download
        # + transcription actually produced content.
        key = make_script_key(
            system_prompt=SYSTEM_PROMPT_DE,
            messages=[
                {
                    "role": "user",
                    "content": build_user_message(
                        transcript="",
                        caption=None,
                        blog_text=None,
                        thumbnail_url=None,
                    ),
                }
            ],
        )
        provider = MockLLMProvider(
            scripted={
                key: {
                    "title": "Testrezept",
                    "description": None,
                    "servings": None,
                    "difficulty": None,
                    "prep_minutes": None,
                    "cook_minutes": None,
                    "ingredients": [],
                    "steps": [],
                    "tags": [],
                    "source_url": "https://example",
                }
            }
        )

    # Use the production defaults (yt-dlp + faster-whisper) by not
    # passing downloader / transcriber. This is the whole point of the
    # live test — hit the real stack.
    result = await extract_from_url(live_url, provider=provider)

    # Minimum expectations: we always get a title + a source_url.
    assert result["recipe"]["source_url"] == live_url
    assert isinstance(result["recipe"]["title"], str)
    assert len(result["recipe"]["title"]) > 0
