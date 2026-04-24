"""Factory that picks the right ``LLMProvider`` from a ``Settings``.

REL-7 added explicit provider routing:

- ``ai_enabled=False`` **or** ``llm_provider="disabled"`` →
  :class:`DisabledProvider` (raises ``ai_disabled``). This is the
  default for fresh installs so the stack boots without any AI
  credentials configured.
- ``ai_enabled=True`` + ``llm_provider="azure"`` →
  :class:`AzureOpenAIProvider` when the API key is set, otherwise
  :class:`NullProvider` (operator said "azure" but forgot to fill in
  the key).
- ``ai_enabled=True`` + ``llm_provider="ollama"`` →
  :class:`OllamaProvider`. No credential check — Ollama runs locally
  on the internal docker network with no auth.

Rationale for the ``NullProvider`` fallback (rather than
``DisabledProvider``) when the Azure API key is missing: those two
cases are semantically different. "Operator disabled AI" is a user-
facing 503; "Operator said azure but the key is empty" is a
misconfigure the admin needs to fix, so we keep the existing
``not_configured`` → 500 path for that case and let
``DisabledProvider`` own the "operator said no AI" path.
"""

from __future__ import annotations

from extractor.config import Settings
from extractor.llm.azure_openai import AzureOpenAIProvider
from extractor.llm.mock import DisabledProvider, NullProvider
from extractor.llm.ollama import OllamaProvider
from extractor.llm.provider import LLMProvider


def build_provider(settings: Settings) -> LLMProvider:
    """Return an ``LLMProvider`` wired from the provided settings.

    See module docstring for the routing rules.
    """
    if not settings.ai_enabled or settings.llm_provider == "disabled":
        return DisabledProvider()

    if settings.llm_provider == "ollama":
        return OllamaProvider(
            base_url=settings.ollama_base_url,
            model=settings.ollama_model,
            vision_model=settings.ollama_vision_model,
        )

    # Azure is the only remaining branch. Whitespace-only API keys count
    # as empty — a ``.env`` with ``AZURE_OPENAI_API_KEY=   `` is a
    # misconfigure, not an intentional value.
    if not settings.azure_openai_api_key.strip():
        return NullProvider()
    return AzureOpenAIProvider(
        endpoint=settings.azure_openai_endpoint,
        api_key=settings.azure_openai_api_key,
        api_version=settings.azure_openai_api_version,
        deployment_structuring=settings.azure_openai_deployment_structuring,
        deployment_chat=settings.azure_openai_deployment_chat,
    )
