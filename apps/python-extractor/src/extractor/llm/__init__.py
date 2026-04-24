"""LLM provider abstraction for the recipe extractor service.

Exposes the public surface consumed by the orchestrator and downstream
sub-slices (P2-2 URL extraction, P2-3 photo extraction, P2-4 chat, and
REL-7 Ollama / AI-disabled routing).
"""

from __future__ import annotations

from extractor.llm.azure_openai import AzureOpenAIProvider
from extractor.llm.errors import LLM_ERROR_CODES, LLMErrorCode, LLMProviderError
from extractor.llm.factory import build_provider
from extractor.llm.mock import DisabledProvider, MockLLMProvider, NullProvider
from extractor.llm.ollama import OllamaProvider
from extractor.llm.provider import ChatMessage, LLMProvider, TokenUsage, VisionInput

__all__ = [
    "LLM_ERROR_CODES",
    "AzureOpenAIProvider",
    "ChatMessage",
    "DisabledProvider",
    "LLMErrorCode",
    "LLMProvider",
    "LLMProviderError",
    "MockLLMProvider",
    "NullProvider",
    "OllamaProvider",
    "TokenUsage",
    "VisionInput",
    "build_provider",
]
