"""Tests for ``MockLLMProvider``.

The mock is used by every downstream sub-slice's tests so no live Azure
call goes out in CI. Its contract:

- Scripted replies keyed by a stable hash of the input messages.
- Unmapped inputs raise ``LLMProviderError(code="not_configured")``.
- It implements every abstract method on ``LLMProvider``.
"""

from __future__ import annotations

import pytest

from extractor.llm import LLMProvider, LLMProviderError
from extractor.llm.mock import MockLLMProvider, make_script_key


def test_mock_is_llm_provider_subclass() -> None:
    """Keeps the mock interchangeable with the real provider at call sites."""
    assert issubclass(MockLLMProvider, LLMProvider)


async def test_extract_structured_returns_scripted_dict() -> None:
    """A matching script key returns its scripted dict payload + default usage."""
    script = {
        make_script_key(
            system_prompt="sys",
            messages=[{"role": "user", "content": "extract"}],
        ): {"title": "Spaghetti"}
    }
    provider = MockLLMProvider(scripted=script)

    result, usage = await provider.extract_structured(
        system_prompt="sys",
        messages=[{"role": "user", "content": "extract"}],
        json_schema={"type": "object"},
    )

    assert result == {"title": "Spaghetti"}
    # Default usage — zero counts, "mock" model.
    assert usage == {
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "cached_prompt_tokens": 0,
        "model": "mock",
    }


async def test_chat_returns_scripted_text() -> None:
    """Chat replies are scripted as strings under the same key scheme."""
    script = {
        make_script_key(
            system_prompt="du bist eine hilfreiche KI",
            messages=[{"role": "user", "content": "hallo"}],
        ): "hallo selbst"
    }
    provider = MockLLMProvider(scripted=script)

    reply, usage = await provider.chat(
        system_prompt="du bist eine hilfreiche KI",
        messages=[{"role": "user", "content": "hallo"}],
    )

    assert reply == "hallo selbst"
    assert usage["model"] == "mock"
    assert usage["prompt_tokens"] == 0


async def test_vision_extract_returns_scripted_dict() -> None:
    """Vision calls are keyed on images + instruction + system prompt."""
    images = [{"image_url": "https://example.test/1.jpg", "detail": "auto"}]
    script = {
        make_script_key(
            system_prompt="extract recipe",
            messages=[{"role": "user", "content": "read images"}],
            extra=("vision", "https://example.test/1.jpg", "auto"),
        ): {"ingredients": ["Mehl"]}
    }
    provider = MockLLMProvider(scripted=script)

    result, usage = await provider.vision_extract(
        system_prompt="extract recipe",
        images=images,  # type: ignore[arg-type]
        instruction="read images",
        json_schema={"type": "object"},
    )

    assert result == {"ingredients": ["Mehl"]}
    assert usage["model"] == "mock"


async def test_extract_structured_expanded_tuple_pins_usage() -> None:
    """Scripting ``(payload, usage)`` overrides the default zero usage."""
    key = make_script_key(
        system_prompt="sys",
        messages=[{"role": "user", "content": "extract"}],
    )
    script = {
        key: (
            {"title": "Pizza"},
            {
                "prompt_tokens": 123,
                "completion_tokens": 45,
                "cached_prompt_tokens": 100,
                "model": "gpt-5.1",
            },
        )
    }
    provider = MockLLMProvider(scripted=script)

    result, usage = await provider.extract_structured(
        system_prompt="sys",
        messages=[{"role": "user", "content": "extract"}],
        json_schema={"type": "object"},
    )

    assert result == {"title": "Pizza"}
    assert usage == {
        "prompt_tokens": 123,
        "completion_tokens": 45,
        "cached_prompt_tokens": 100,
        "model": "gpt-5.1",
    }


async def test_chat_expanded_tuple_pins_usage() -> None:
    """Scripting chat replies with explicit usage works too."""
    key = make_script_key(
        system_prompt="sys",
        messages=[{"role": "user", "content": "hi"}],
    )
    script = {
        key: (
            "antwort",
            {
                "prompt_tokens": 50,
                "completion_tokens": 12,
                "cached_prompt_tokens": 0,
                "model": "gpt-5.1-chat",
            },
        )
    }
    provider = MockLLMProvider(scripted=script)

    reply, usage = await provider.chat(
        system_prompt="sys",
        messages=[{"role": "user", "content": "hi"}],
    )

    assert reply == "antwort"
    assert usage["model"] == "gpt-5.1-chat"
    assert usage["prompt_tokens"] == 50
    assert usage["completion_tokens"] == 12


async def test_unmapped_extract_structured_raises_not_configured() -> None:
    """Unknown input → ``not_configured``, so forgotten scripts fail loudly."""
    provider = MockLLMProvider(scripted={})

    with pytest.raises(LLMProviderError) as exc_info:
        await provider.extract_structured(
            system_prompt="sys",
            messages=[{"role": "user", "content": "unknown"}],
            json_schema={"type": "object"},
        )
    assert exc_info.value.code == "not_configured"


async def test_unmapped_chat_raises_not_configured() -> None:
    """Unknown chat input → ``not_configured``."""
    provider = MockLLMProvider(scripted={})

    with pytest.raises(LLMProviderError) as exc_info:
        await provider.chat(
            system_prompt="sys",
            messages=[{"role": "user", "content": "unknown"}],
        )
    assert exc_info.value.code == "not_configured"


async def test_unmapped_vision_extract_raises_not_configured() -> None:
    """Unknown vision input → ``not_configured``."""
    provider = MockLLMProvider(scripted={})

    with pytest.raises(LLMProviderError) as exc_info:
        await provider.vision_extract(
            system_prompt="sys",
            images=[{"image_url": "https://x.test/a.jpg", "detail": "auto"}],
            instruction="inst",
            json_schema={"type": "object"},
        )
    assert exc_info.value.code == "not_configured"


def test_script_key_is_stable_across_calls() -> None:
    """The key function must be deterministic — the same input → same key."""
    k1 = make_script_key(
        system_prompt="sys",
        messages=[{"role": "user", "content": "hi"}],
    )
    k2 = make_script_key(
        system_prompt="sys",
        messages=[{"role": "user", "content": "hi"}],
    )
    assert k1 == k2


def test_script_key_differs_on_different_input() -> None:
    """Different messages → different keys (basic collision-avoidance check)."""
    k1 = make_script_key(
        system_prompt="sys",
        messages=[{"role": "user", "content": "hi"}],
    )
    k2 = make_script_key(
        system_prompt="sys",
        messages=[{"role": "user", "content": "bye"}],
    )
    assert k1 != k2


def test_mock_has_no_extra_public_methods() -> None:
    """Anti-shortcut reminder (plan §7): mock must not expose test-only API.

    Any public attribute (no leading underscore) must either come from
    the ``LLMProvider`` interface or be an accepted constructor field.
    """
    allowed = {"extract_structured", "chat", "vision_extract"}
    public = {name for name in vars(MockLLMProvider) if not name.startswith("_")}
    # `__init__` is allowed on any class; it's filtered by the underscore check.
    assert public <= allowed
