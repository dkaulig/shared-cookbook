"""Tests for :mod:`extractor.pipeline.chat`.

Covers the one remaining exported coroutine:

- :func:`chat_to_recipe` — calls :meth:`LLMProvider.extract_structured`
  on the full dialog and pipes the result through
  :func:`extractor.pipeline.post_process.post_process`.

CR5 removed the conversational ``chat_turn`` helper — chat turns are
served by the .NET API directly; only the to-recipe conversion remains
here.

All tests use a local fake ``LLMProvider`` — no Azure, no network.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import pytest

from extractor.llm import ChatMessage, LLMProvider, LLMProviderError, TokenUsage
from extractor.pipeline.chat import (
    MAX_MESSAGES,
    EmptyMessagesError,
    MessagesTooLongError,
    chat_to_recipe,
)
from extractor.prompts.chat import (
    RECIPE_SCHEMA,
    TO_RECIPE_SYSTEM_PROMPT_DE,
)

# ─────────────────────────────────────────────────────────────────────
# Fakes
# ─────────────────────────────────────────────────────────────────────


def _stub_usage() -> TokenUsage:
    """Fresh :class:`TokenUsage` dict the fakes return. Built per call so
    mutating one doesn't leak into the shared template."""
    return {
        "prompt_tokens": 120,
        "completion_tokens": 40,
        "cached_prompt_tokens": 0,
        "model": "gpt-5.1-chat",
    }


class _RecordingProvider(LLMProvider):
    """Captures call arguments and returns a canned extract reply + usage."""

    def __init__(
        self,
        *,
        extract_reply: dict[str, Any] | None = None,
        usage: TokenUsage | None = None,
    ) -> None:
        self.extract_reply: dict[str, Any] = extract_reply or _canonical_recipe_payload()
        self.usage: TokenUsage = usage if usage is not None else _stub_usage()
        self.extract_calls: list[tuple[str, tuple[ChatMessage, ...], dict[str, Any]]] = []

    async def extract_structured(
        self,
        system_prompt: str,
        messages: Sequence[ChatMessage],
        json_schema: dict[str, Any],
    ) -> tuple[dict[str, Any], TokenUsage]:
        self.extract_calls.append((system_prompt, tuple(messages), json_schema))
        return dict(self.extract_reply), self.usage

    async def chat(
        self, system_prompt: str, messages: Sequence[ChatMessage]
    ) -> tuple[str, TokenUsage]:
        raise NotImplementedError

    async def vision_extract(
        self,
        system_prompt: str,
        images: Sequence[Any],
        instruction: str,
        json_schema: dict[str, Any],
    ) -> tuple[dict[str, Any], TokenUsage]:
        raise NotImplementedError


class _FailingProvider(LLMProvider):
    """Raises the configured :class:`LLMProviderError` on every call."""

    def __init__(self, error: LLMProviderError) -> None:
        self.error = error

    async def extract_structured(
        self,
        system_prompt: str,
        messages: Sequence[ChatMessage],
        json_schema: dict[str, Any],
    ) -> tuple[dict[str, Any], TokenUsage]:
        raise self.error

    async def chat(
        self, system_prompt: str, messages: Sequence[ChatMessage]
    ) -> tuple[str, TokenUsage]:
        raise self.error

    async def vision_extract(
        self,
        system_prompt: str,
        images: Sequence[Any],
        instruction: str,
        json_schema: dict[str, Any],
    ) -> tuple[dict[str, Any], TokenUsage]:
        raise self.error


def _canonical_recipe_payload() -> dict[str, Any]:
    return {
        "title": "Kartoffelgratin",
        "description": "Cremiger Gratin.",
        "servings": 4,
        "difficulty": 2,
        "prep_minutes": 15,
        "cook_minutes": 45,
        "ingredients": [
            {
                "name": "Kartoffeln",
                "quantity": "1",
                "unit": "kg",
                "note": None,
                "confidence": "high",
            }
        ],
        "steps": [
            {"position": 1, "content": "Kartoffeln schälen.", "confidence": "high"},
        ],
        "tags": ["vegan"],
        "source_url": "ignored-by-post-process",
        "thumbnail_url": None,
    }


# ─────────────────────────────────────────────────────────────────────
# chat_to_recipe
# ─────────────────────────────────────────────────────────────────────


async def test_chat_to_recipe_returns_structured_result() -> None:
    """Mock provider JSON + chat history → ExtractionResult."""
    provider = _RecordingProvider()
    messages: list[ChatMessage] = [
        {"role": "user", "content": "Ich hab Kartoffeln"},
        {"role": "assistant", "content": "Alles klar, Gratin?"},
        {"role": "user", "content": "Ja, für 4 Personen"},
    ]

    result = await chat_to_recipe(messages, provider, session_id="abc123")

    assert result["recipe"]["title"] == "Kartoffelgratin"
    # post_process pins source_url to the synthesized chat: URL —
    # the LLM-supplied value is ignored.
    assert result["recipe"]["source_url"] == "chat:abc123"
    assert result["recipe"]["thumbnail_url"] is None
    assert result["confidence"]["overall"] in ("high", "medium", "low")


async def test_chat_to_recipe_forwards_to_provider_with_schema() -> None:
    """The structuring call uses the to-recipe prompt + RECIPE_SCHEMA."""
    provider = _RecordingProvider()
    messages: list[ChatMessage] = [{"role": "user", "content": "Rezept bitte"}]

    await chat_to_recipe(messages, provider, session_id="s")

    assert len(provider.extract_calls) == 1
    (system_prompt, forwarded, schema) = provider.extract_calls[0]
    assert system_prompt == TO_RECIPE_SYSTEM_PROMPT_DE
    assert list(forwarded) == messages
    assert schema is RECIPE_SCHEMA


async def test_chat_to_recipe_rejects_empty_messages() -> None:
    """Empty history → EmptyMessagesError before any provider call."""
    provider = _RecordingProvider()
    with pytest.raises(EmptyMessagesError):
        await chat_to_recipe([], provider, session_id="s")
    assert provider.extract_calls == []


async def test_chat_to_recipe_rejects_over_max_length() -> None:
    """31-turn history → MessagesTooLongError."""
    provider = _RecordingProvider()
    messages: list[ChatMessage] = [
        {"role": "user", "content": f"Nachricht {i}"} for i in range(MAX_MESSAGES + 1)
    ]
    with pytest.raises(MessagesTooLongError):
        await chat_to_recipe(messages, provider, session_id="s")
    assert provider.extract_calls == []


async def test_chat_to_recipe_attaches_usage_to_result() -> None:
    """PF2: the provider :class:`TokenUsage` surfaces on the returned
    :class:`ExtractionResult` so the HTTP layer can emit
    ``X-Extractor-*`` headers."""
    provider = _RecordingProvider()
    messages: list[ChatMessage] = [{"role": "user", "content": "Rezept bitte"}]

    result = await chat_to_recipe(messages, provider, session_id="s")

    assert "usage" in result
    usage = result["usage"]
    assert usage["prompt_tokens"] == 120
    assert usage["completion_tokens"] == 40
    assert usage["cached_prompt_tokens"] == 0
    assert usage["model"] == "gpt-5.1-chat"


async def test_chat_to_recipe_propagates_provider_error() -> None:
    """Provider raises LLMProviderError → chat_to_recipe surfaces it."""
    error = LLMProviderError("outage", code="provider_unavailable")
    provider = _FailingProvider(error)
    messages: list[ChatMessage] = [{"role": "user", "content": "Rezept bitte"}]

    with pytest.raises(LLMProviderError) as exc_info:
        await chat_to_recipe(messages, provider, session_id="s")

    assert exc_info.value is error
