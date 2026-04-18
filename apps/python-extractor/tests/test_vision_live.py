"""Live Vision-LLM integration smoke for the photo-extraction pipeline.

This test actually calls Azure OpenAI's Vision endpoint with one or more
real image URLs. It is slow, billable, and network-dependent, so it's
gated behind two env vars:

- ``EXTRACTOR_VISION_LIVE=1`` — opts in to running the test at all.
- ``AZURE_OPENAI_INTEGRATION=1`` — must also be set so the real
  ``AzureOpenAIProvider`` is built. If it isn't, the test skips rather
  than silently running against a mock.

The operator provides the image URL(s) via ``EXTRACTOR_VISION_URLS`` as
a comma-separated list. We never hard-code a specific creator's image —
the test expects the operator to point at photos they own or can
legally process. A single public test image is fine.

Run locally with::

    EXTRACTOR_VISION_LIVE=1 \\
    AZURE_OPENAI_INTEGRATION=1 \\
    AZURE_OPENAI_ENDPOINT=https://... \\
    AZURE_OPENAI_API_KEY=... \\
    EXTRACTOR_VISION_URLS=https://example.com/recipe-page.jpg \\
      uv run pytest tests/test_vision_live.py -v

This test is never run in CI.
"""

from __future__ import annotations

import os

import pytest

from extractor.config import Settings
from extractor.llm import build_provider
from extractor.pipeline.photo import extract_from_photos

_LIVE_GATE = "EXTRACTOR_VISION_LIVE"
_AZURE_GATE = "AZURE_OPENAI_INTEGRATION"
_URLS_ENV = "EXTRACTOR_VISION_URLS"


pytestmark = pytest.mark.skipif(
    os.environ.get(_LIVE_GATE) != "1" or os.environ.get(_AZURE_GATE) != "1",
    reason=(
        "live Azure Vision call; enable with EXTRACTOR_VISION_LIVE=1 and "
        "AZURE_OPENAI_INTEGRATION=1 and populate AZURE_OPENAI_ENDPOINT + "
        "AZURE_OPENAI_API_KEY + EXTRACTOR_VISION_URLS=<comma-separated urls>."
    ),
)


async def test_live_vision_pipeline_runs_end_to_end() -> None:
    """Call the real Azure Vision endpoint on operator-supplied image(s)
    and assert we get a structured recipe shell back."""
    raw_urls = os.environ.get(_URLS_ENV)
    if not raw_urls:
        pytest.skip(
            f"set {_URLS_ENV} to a comma-separated list of publicly-fetchable "
            "recipe-photo URLs before running this test."
        )
    photo_urls = [u.strip() for u in raw_urls.split(",") if u.strip()]
    assert 1 <= len(photo_urls) <= 10, (
        f"{_URLS_ENV} must contain between 1 and 10 URLs (got {len(photo_urls)})."
    )

    provider = build_provider(Settings())

    result = await extract_from_photos(photo_urls, provider=provider)

    # Minimum expectations: the pipeline returned a structured recipe
    # with its source-url sentinel and a non-empty title. We avoid
    # asserting ingredient / step counts — a photo of the wrong side of
    # the page could legitimately yield zero. The goal of this smoke is
    # just to confirm the Vision call reached Azure and came back.
    assert result["recipe"]["source_url"] == "photos://upload"
    assert isinstance(result["recipe"]["title"], str)
    assert len(result["recipe"]["title"]) > 0
    assert result["confidence"]["overall"] in ("high", "medium", "low")
