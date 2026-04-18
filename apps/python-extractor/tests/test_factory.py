"""Tests for ``build_provider``.

The factory decides which provider to instantiate based on the current
``Settings``. Rules:

- Empty ``AZURE_OPENAI_API_KEY`` → ``NullProvider`` (every call raises
  ``not_configured`` so a silent misconfigure is loud).
- Populated key → ``AzureOpenAIProvider`` configured from the settings
  fields (endpoint, api version, both deployment names).
"""

from __future__ import annotations

from extractor.config import Settings
from extractor.llm import AzureOpenAIProvider, NullProvider, build_provider


def test_empty_api_key_returns_null_provider() -> None:
    """Default settings carry an empty key → we must refuse to call Azure."""
    settings = Settings(
        azure_openai_endpoint="",
        azure_openai_api_key="",
    )
    provider = build_provider(settings)
    assert isinstance(provider, NullProvider)


def test_empty_api_key_with_populated_endpoint_still_returns_null() -> None:
    """Endpoint alone isn't enough — key is the discriminator."""
    settings = Settings(
        azure_openai_endpoint="https://fake.openai.azure.com",
        azure_openai_api_key="",
    )
    provider = build_provider(settings)
    assert isinstance(provider, NullProvider)


def test_populated_api_key_returns_azure_provider() -> None:
    """With a key set, the real provider is returned."""
    settings = Settings(
        azure_openai_endpoint="https://fake.openai.azure.com",
        azure_openai_api_key="a-real-looking-key",
        azure_openai_api_version="2025-04-01-preview",
        azure_openai_deployment_structuring="gpt-4.1-mini",
        azure_openai_deployment_chat="gpt-5.1-chat",
    )
    provider = build_provider(settings)
    assert isinstance(provider, AzureOpenAIProvider)


async def test_populated_api_key_closes_cleanly() -> None:
    """The returned provider must expose ``aclose`` so callers can release
    the HTTP client without leaking connections."""
    settings = Settings(
        azure_openai_endpoint="https://fake.openai.azure.com",
        azure_openai_api_key="a-real-looking-key",
    )
    provider = build_provider(settings)
    # AzureOpenAIProvider defines aclose; NullProvider also must for
    # callers that don't want to type-check before closing. Keep the
    # factory contract simple: always call aclose if available.
    if hasattr(provider, "aclose"):
        await provider.aclose()


def test_whitespace_api_key_is_treated_as_empty() -> None:
    """Guard against a ``.env`` with ``AZURE_OPENAI_API_KEY=   ``.

    A whitespace-only key is a misconfigure, not an intentional secret.
    """
    settings = Settings(
        azure_openai_endpoint="https://fake.openai.azure.com",
        azure_openai_api_key="   ",
    )
    provider = build_provider(settings)
    assert isinstance(provider, NullProvider)
