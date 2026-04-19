"""Tests for :mod:`extractor.pipeline.chat`.

Covers both exported coroutines:

- :func:`chat_turn` — thin wrapper over :meth:`LLMProvider.chat`, plus
  length + emptiness validation that surfaces as ``ValueError``.
- :func:`chat_to_recipe` — calls :meth:`LLMProvider.extract_structured`
  on the full dialog and pipes the result through
  :func:`extractor.pipeline.post_process.post_process`.

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
    chat_turn,
)
from extractor.prompts.chat import (
    CHAT_SYSTEM_PROMPT_DE,
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
    """Captures call arguments and returns a canned reply + usage."""

    def __init__(
        self,
        *,
        chat_reply: str = "Klar, ich helfe gerne!",
        extract_reply: dict[str, Any] | None = None,
        usage: TokenUsage | None = None,
    ) -> None:
        self.chat_reply = chat_reply
        self.extract_reply: dict[str, Any] = extract_reply or _canonical_recipe_payload()
        self.usage: TokenUsage = usage if usage is not None else _stub_usage()
        self.chat_calls: list[tuple[str, tuple[ChatMessage, ...]]] = []
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
        self.chat_calls.append((system_prompt, tuple(messages)))
        return self.chat_reply, self.usage

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
# chat_turn
# ─────────────────────────────────────────────────────────────────────


async def test_chat_turn_single_message_returns_provider_reply() -> None:
    """One-turn dialogue — provider called once, reply returned verbatim."""
    provider = _RecordingProvider(chat_reply="Hallo!")
    messages: list[ChatMessage] = [{"role": "user", "content": "Hi"}]

    reply = await chat_turn(messages, provider)

    assert reply == "Hallo!"
    assert len(provider.chat_calls) == 1
    (system_prompt, forwarded) = provider.chat_calls[0]
    assert system_prompt == CHAT_SYSTEM_PROMPT_DE
    assert forwarded == tuple(messages)


async def test_chat_turn_five_turn_dialogue_preserves_order() -> None:
    """All 5 turns reach the provider in the order the caller sent them."""
    provider = _RecordingProvider(chat_reply="Klar.")
    messages: list[ChatMessage] = [
        {"role": "user", "content": "Ich hab Kartoffeln, Quark, Lauch"},
        {"role": "assistant", "content": "Welche Ernährung?"},
        {"role": "user", "content": "Vegan bitte"},
        {"role": "assistant", "content": "Wie viele Portionen?"},
        {"role": "user", "content": "4 Personen"},
    ]

    reply = await chat_turn(messages, provider)

    assert reply == "Klar."
    (_, forwarded) = provider.chat_calls[0]
    assert list(forwarded) == messages


async def test_chat_turn_rejects_empty_messages() -> None:
    """Empty ``messages`` → :class:`EmptyMessagesError` (maps to HTTP 400)."""
    provider = _RecordingProvider()
    with pytest.raises(EmptyMessagesError):
        await chat_turn([], provider)
    assert provider.chat_calls == []


async def test_chat_turn_rejects_over_max_length() -> None:
    """31-turn conversation → :class:`MessagesTooLongError` (maps to HTTP 413)."""
    provider = _RecordingProvider()
    messages: list[ChatMessage] = [
        {"role": "user", "content": f"Nachricht {i}"} for i in range(MAX_MESSAGES + 1)
    ]
    with pytest.raises(MessagesTooLongError):
        await chat_turn(messages, provider)
    assert provider.chat_calls == []


async def test_chat_turn_accepts_exactly_max_length() -> None:
    """30-turn conversation (the cap) is still accepted."""
    provider = _RecordingProvider(chat_reply="ok")
    messages: list[ChatMessage] = [
        {"role": "user", "content": f"Nachricht {i}"} for i in range(MAX_MESSAGES)
    ]

    reply = await chat_turn(messages, provider)

    assert reply == "ok"
    assert len(provider.chat_calls) == 1


async def test_chat_turn_propagates_provider_error() -> None:
    """:class:`LLMProviderError` from the provider is re-raised unchanged."""
    error = LLMProviderError("azure down", code="provider_unavailable")
    provider = _FailingProvider(error)
    messages: list[ChatMessage] = [{"role": "user", "content": "Hi"}]

    with pytest.raises(LLMProviderError) as exc_info:
        await chat_turn(messages, provider)

    assert exc_info.value is error


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


async def test_chat_to_recipe_propagates_provider_error() -> None:
    """Provider raises LLMProviderError → chat_to_recipe surfaces it."""
    error = LLMProviderError("outage", code="provider_unavailable")
    provider = _FailingProvider(error)
    messages: list[ChatMessage] = [{"role": "user", "content": "Rezept bitte"}]

    with pytest.raises(LLMProviderError) as exc_info:
        await chat_to_recipe(messages, provider, session_id="s")

    assert exc_info.value is error
