"""Tests for ``DisabledProvider`` — REL-7 "operator disabled AI" branch.

The contract:
- It is an ``LLMProvider``.
- Every method raises ``LLMProviderError(code="ai_disabled")``.
- The error message references ``LLM_PROVIDER`` so ops can fix quickly.
- Distinct from ``NullProvider`` (``not_configured``) — the two codes
  drive different HTTP responses at the FastAPI layer.
"""

from __future__ import annotations

import pytest

from extractor.llm import LLMProvider, LLMProviderError
from extractor.llm.mock import DisabledProvider


def test_disabled_provider_is_llm_provider_subclass() -> None:
    """Interchangeable with the real provider at call sites."""
    assert issubclass(DisabledProvider, LLMProvider)


async def test_extract_structured_raises_ai_disabled() -> None:
    provider = DisabledProvider()
    with pytest.raises(LLMProviderError) as exc_info:
        await provider.extract_structured(
            system_prompt="sys",
            messages=[{"role": "user", "content": "x"}],
            json_schema={"type": "object"},
        )
    assert exc_info.value.code == "ai_disabled"
    assert "LLM_PROVIDER" in str(exc_info.value)


async def test_chat_raises_ai_disabled() -> None:
    provider = DisabledProvider()
    with pytest.raises(LLMProviderError) as exc_info:
        await provider.chat(
            system_prompt="sys",
            messages=[{"role": "user", "content": "x"}],
        )
    assert exc_info.value.code == "ai_disabled"


async def test_vision_extract_raises_ai_disabled() -> None:
    provider = DisabledProvider()
    with pytest.raises(LLMProviderError) as exc_info:
        await provider.vision_extract(
            system_prompt="sys",
            images=[{"image_url": "https://example/x.jpg", "detail": "auto"}],
            instruction="ex",
            json_schema={"type": "object"},
        )
    assert exc_info.value.code == "ai_disabled"
