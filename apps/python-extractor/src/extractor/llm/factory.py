"""Factory that picks the right ``LLMProvider`` from a ``Settings``.

Today there's one production provider (Azure OpenAI via the Responses
API); swapping in OpenAI-direct or Gemini later is a config-only change
— pick on a new ``LLM_PROVIDER`` env var, return a different subclass.

Rule: if ``AZURE_OPENAI_API_KEY`` is empty (or whitespace-only, which
is the usual ``.env`` misconfigure mode), return a ``NullProvider`` so
the first call surfaces ``not_configured`` instead of silently talking
to a non-existent endpoint.
"""

from __future__ import annotations

from extractor.config import Settings
from extractor.llm.azure_openai import AzureOpenAIProvider
from extractor.llm.mock import NullProvider
from extractor.llm.provider import LLMProvider


def build_provider(settings: Settings) -> LLMProvider:
    """Return an ``LLMProvider`` wired from the provided settings.

    Whitespace-only API keys count as empty — a ``.env`` with
    ``AZURE_OPENAI_API_KEY=   `` is a misconfigure, not an intentional
    value. We use ``str.strip`` to normalise before the check but pass
    the raw value through to the provider so any trailing whitespace a
    user really wants persists to the request header.
    """
    if not settings.azure_openai_api_key.strip():
        return NullProvider()
    return AzureOpenAIProvider(
        endpoint=settings.azure_openai_endpoint,
        api_key=settings.azure_openai_api_key,
        api_version=settings.azure_openai_api_version,
        deployment_structuring=settings.azure_openai_deployment_structuring,
        deployment_chat=settings.azure_openai_deployment_chat,
    )
