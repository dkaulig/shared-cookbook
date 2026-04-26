"""Tests for :mod:`extractor.prompt_seed`.

CFG-1b — verifies the one-shot startup hook that posts the real DE
system prompts to the .NET internal seed endpoint. The contract is:

- POST body carries the three real prompt strings (not placeholders).
- Success path: the per-key summary lands in the INFO log so an
  operator tail of the extractor log shows ``written/written/written``.
- Transport failure: log a WARNING + return cleanly. The extractor
  startup MUST NOT propagate the exception; cache TTL re-tries cover
  the eventual-consistency window.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx
import pytest

from extractor.prompt_seed import seed_prompts
from extractor.prompts.chat import TO_RECIPE_SYSTEM_PROMPT_DE
from extractor.prompts.photo_recipe import SYSTEM_PROMPT_DE as PHOTO_SYSTEM_PROMPT_DE
from extractor.prompts.recipe_extraction import SYSTEM_PROMPT_DE as STRUCTURED_SYSTEM_PROMPT_DE


def _make_client(handler: Any) -> httpx.AsyncClient:
    """Build an ``httpx.AsyncClient`` against an in-memory MockTransport."""
    return httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        base_url="http://api.test",
    )


@pytest.mark.asyncio
async def test_seed_prompts_posts_three_real_prompts(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Happy path: the POST body carries the three real strings + the
    success summary lands in the INFO log."""
    captured: dict[str, Any] = {}

    def _handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["url"] = str(request.url)
        captured["body"] = request.content
        return httpx.Response(
            200,
            json={
                "structured": "written",
                "chat": "written",
                "vision": "written",
            },
        )

    async with _make_client(_handler) as client:
        with caplog.at_level(logging.INFO, logger="extractor.prompt_seed"):
            await seed_prompts(client)

    assert captured["method"] == "POST"
    assert captured["url"].endswith("/api/internal/extractor-config/seed-prompts")

    import json

    payload = json.loads(captured["body"])
    assert payload["structured"] == STRUCTURED_SYSTEM_PROMPT_DE
    assert payload["chat"] == TO_RECIPE_SYSTEM_PROMPT_DE
    assert payload["vision"] == PHOTO_SYSTEM_PROMPT_DE

    # Per-key outcome is in the INFO log so an operator tail shows it.
    info_lines = [r.message for r in caplog.records if r.levelno == logging.INFO]
    assert any("written" in line and "structured" in line for line in info_lines), (
        f"expected per-key summary in INFO log, got: {info_lines!r}"
    )


@pytest.mark.asyncio
async def test_seed_prompts_logs_and_continues_on_transport_error(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Connect failure must NOT raise — extractor startup must boot
    even when the .NET API is briefly unreachable."""

    def _handler(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("API not up yet")

    async with _make_client(_handler) as client:
        with caplog.at_level(logging.WARNING, logger="extractor.prompt_seed"):
            # Must not raise.
            await seed_prompts(client)

    warnings = [r.message for r in caplog.records if r.levelno == logging.WARNING]
    assert any("prompt_seed" in line for line in warnings), (
        f"expected WARNING log on transport error, got: {warnings!r}"
    )


@pytest.mark.asyncio
async def test_seed_prompts_logs_warning_on_4xx(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """4xx body is logged at WARNING — operator can diagnose the
    rejection (e.g. oversized prompt) without an exception."""

    def _handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400,
            json={
                "code": "invalid_value",
                "message": "Prompt too long.",
                "status": 400,
                "fieldName": "structured",
            },
        )

    async with _make_client(_handler) as client:
        with caplog.at_level(logging.WARNING, logger="extractor.prompt_seed"):
            await seed_prompts(client)

    warnings = [r.message for r in caplog.records if r.levelno == logging.WARNING]
    assert any("status=400" in line for line in warnings), (
        f"expected WARNING with status=400, got: {warnings!r}"
    )
