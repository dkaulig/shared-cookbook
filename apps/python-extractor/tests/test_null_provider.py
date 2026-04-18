"""Tests for ``NullProvider`` — the safe-default returned by ``build_provider``
when ``AZURE_OPENAI_API_KEY`` is empty.

The contract:
- It is an ``LLMProvider``.
- Every method raises ``LLMProviderError(code="not_configured")``.
- The error message names the missing env var so ops can fix quickly.
"""

from __future__ import annotations

import pytest

from extractor.llm import LLMProvider, LLMProviderError
from extractor.llm.mock import NullProvider


def test_null_provider_is_llm_provider_subclass() -> None:
    """Interchangeable with the real provider at call sites."""
    assert issubclass(NullProvider, LLMProvider)


async def test_extract_structured_raises_not_configured() -> None:
    """Calling without config must be a loud, actionable error."""
    provider = NullProvider()

    with pytest.raises(LLMProviderError) as exc_info:
        await provider.extract_structured(
            system_prompt="sys",
            messages=[{"role": "user", "content": "x"}],
            json_schema={"type": "object"},
        )
    assert exc_info.value.code == "not_configured"
    assert "AZURE_OPENAI_API_KEY" in str(exc_info.value)


async def test_chat_raises_not_configured() -> None:
    """Same for ``chat``."""
    provider = NullProvider()

    with pytest.raises(LLMProviderError) as exc_info:
        await provider.chat(
            system_prompt="sys",
            messages=[{"role": "user", "content": "x"}],
        )
    assert exc_info.value.code == "not_configured"
    assert "AZURE_OPENAI_API_KEY" in str(exc_info.value)


async def test_vision_extract_raises_not_configured() -> None:
    """Same for ``vision_extract``."""
    provider = NullProvider()

    with pytest.raises(LLMProviderError) as exc_info:
        await provider.vision_extract(
            system_prompt="sys",
            images=[{"image_url": "https://x.test/a.jpg", "detail": "auto"}],
            instruction="inst",
            json_schema={"type": "object"},
        )
    assert exc_info.value.code == "not_configured"
    assert "AZURE_OPENAI_API_KEY" in str(exc_info.value)
