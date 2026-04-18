"""Structural tests for the ``LLMProvider`` abstract interface.

We don't test behaviour here — that belongs on the concrete
implementations. These tests pin the shape of the contract so a future
slice that accidentally renames a method, relaxes an abstractmethod, or
drops a TypedDict field fails fast.
"""

from __future__ import annotations

import inspect
from typing import Literal, get_type_hints

import pytest

from extractor.llm.provider import ChatMessage, LLMProvider, VisionInput


def test_llm_provider_is_abstract() -> None:
    """``LLMProvider`` itself must not be instantiable."""
    with pytest.raises(TypeError):
        LLMProvider()  # type: ignore[abstract]


def test_llm_provider_declares_required_abstract_methods() -> None:
    """All three methods are abstract — a subclass must override every one."""
    # `__abstractmethods__` is a frozenset on ABC subclasses.
    assert LLMProvider.__abstractmethods__ == frozenset(
        {"extract_structured", "chat", "vision_extract"}
    )


def test_extract_structured_is_coroutine() -> None:
    """``extract_structured`` is async — the rest of the service is async."""
    assert inspect.iscoroutinefunction(LLMProvider.extract_structured)


def test_chat_is_coroutine() -> None:
    """``chat`` is async for the same reason."""
    assert inspect.iscoroutinefunction(LLMProvider.chat)


def test_vision_extract_is_coroutine() -> None:
    """``vision_extract`` is async for the same reason."""
    assert inspect.iscoroutinefunction(LLMProvider.vision_extract)


def test_chat_message_typed_dict_fields() -> None:
    """``ChatMessage`` is the on-wire shape — drift breaks every provider."""
    hints = get_type_hints(ChatMessage)
    assert set(hints.keys()) == {"role", "content"}
    # `role` is a Literal of the three valid OpenAI roles.
    assert hints["role"] == Literal["system", "user", "assistant"]
    assert hints["content"] is str


def test_vision_input_typed_dict_fields() -> None:
    """``VisionInput`` pins the two fields every vision call ships."""
    hints = get_type_hints(VisionInput)
    assert set(hints.keys()) == {"image_url", "detail"}
    assert hints["image_url"] is str
    assert hints["detail"] == Literal["low", "high", "auto"]


def test_chat_message_round_trips_dict_literal() -> None:
    """``ChatMessage`` is a ``TypedDict`` — instantiable from a dict literal."""
    msg: ChatMessage = {"role": "user", "content": "hallo"}
    assert msg["role"] == "user"
    assert msg["content"] == "hallo"


def test_vision_input_round_trips_dict_literal() -> None:
    """``VisionInput`` is a ``TypedDict`` — instantiable from a dict literal."""
    vi: VisionInput = {"image_url": "https://example.test/x.jpg", "detail": "auto"}
    assert vi["image_url"] == "https://example.test/x.jpg"
    assert vi["detail"] == "auto"
