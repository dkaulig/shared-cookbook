"""Tests for ``build_provider``.

The factory picks the concrete LLM provider from the current
:class:`Settings`. REL-7 expanded the rules:

- ``ai_enabled=False`` **or** ``llm_provider="disabled"`` →
  :class:`DisabledProvider` (every call raises ``ai_disabled``).
- ``ai_enabled=True`` + ``llm_provider="ollama"`` →
  :class:`OllamaProvider`.
- ``ai_enabled=True`` + ``llm_provider="azure"`` + populated API key →
  :class:`AzureOpenAIProvider`.
- ``ai_enabled=True`` + ``llm_provider="azure"`` + empty API key →
  :class:`NullProvider` (misconfigure — distinct from ``ai_disabled``).
"""

from __future__ import annotations

from extractor.config import Settings
from extractor.llm import (
    AzureOpenAIProvider,
    DisabledProvider,
    NullProvider,
    OllamaProvider,
    build_provider,
)

# ─────────────────────────────────────────────────────────────────────
# Disabled branch (fresh-install default)
# ─────────────────────────────────────────────────────────────────────


def test_default_settings_return_disabled_provider() -> None:
    """Fresh install (no env overrides) boots with AI off."""
    settings = Settings()
    provider = build_provider(settings)
    assert isinstance(provider, DisabledProvider)


def test_ai_disabled_flag_wins_over_provider_choice() -> None:
    """Even if the operator sets ``LLM_PROVIDER=azure``, leaving
    ``AI_ENABLED=false`` must keep AI disabled — both switches have to
    flip for AI to turn on."""
    settings = Settings(
        ai_enabled=False,
        llm_provider="azure",
        azure_openai_api_key="a-real-key",
    )
    provider = build_provider(settings)
    assert isinstance(provider, DisabledProvider)


def test_explicit_provider_disabled_returns_disabled_provider() -> None:
    """``LLM_PROVIDER=disabled`` forces the disabled branch even when
    ``AI_ENABLED=true`` — belt-and-suspenders for operators."""
    settings = Settings(ai_enabled=True, llm_provider="disabled")
    provider = build_provider(settings)
    assert isinstance(provider, DisabledProvider)


# ─────────────────────────────────────────────────────────────────────
# Ollama branch
# ─────────────────────────────────────────────────────────────────────


def test_ollama_routing_returns_ollama_provider() -> None:
    settings = Settings(
        ai_enabled=True,
        llm_provider="ollama",
        ollama_base_url="http://ollama:11434",
        ollama_model="gemma3:12b",
        ollama_vision_model="gemma3:12b",
    )
    provider = build_provider(settings)
    assert isinstance(provider, OllamaProvider)


async def test_ollama_provider_closes_cleanly() -> None:
    settings = Settings(ai_enabled=True, llm_provider="ollama")
    provider = build_provider(settings)
    if hasattr(provider, "aclose"):
        await provider.aclose()


# ─────────────────────────────────────────────────────────────────────
# Azure branch
# ─────────────────────────────────────────────────────────────────────


def test_azure_routing_with_populated_key_returns_azure_provider() -> None:
    settings = Settings(
        ai_enabled=True,
        llm_provider="azure",
        azure_openai_endpoint="https://fake.openai.azure.com",
        azure_openai_api_key="a-real-looking-key",
    )
    provider = build_provider(settings)
    assert isinstance(provider, AzureOpenAIProvider)


def test_azure_routing_with_empty_key_falls_back_to_null_provider() -> None:
    """Operator chose Azure but forgot the key. Surface as misconfigure
    (``not_configured``), not ``ai_disabled`` — the two are distinct."""
    settings = Settings(
        ai_enabled=True,
        llm_provider="azure",
        azure_openai_endpoint="https://fake.openai.azure.com",
        azure_openai_api_key="",
    )
    provider = build_provider(settings)
    assert isinstance(provider, NullProvider)


def test_azure_routing_with_whitespace_key_falls_back_to_null_provider() -> None:
    """Whitespace-only keys still count as empty."""
    settings = Settings(
        ai_enabled=True,
        llm_provider="azure",
        azure_openai_endpoint="https://fake.openai.azure.com",
        azure_openai_api_key="   ",
    )
    provider = build_provider(settings)
    assert isinstance(provider, NullProvider)


async def test_populated_api_key_closes_cleanly() -> None:
    """The returned provider must expose ``aclose`` so callers can release
    the HTTP client without leaking connections."""
    settings = Settings(
        ai_enabled=True,
        llm_provider="azure",
        azure_openai_endpoint="https://fake.openai.azure.com",
        azure_openai_api_key="a-real-looking-key",
    )
    provider = build_provider(settings)
    if hasattr(provider, "aclose"):
        await provider.aclose()
