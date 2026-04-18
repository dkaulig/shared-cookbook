"""LLM provider abstraction for the recipe extractor service.

Exposes the public surface consumed by the orchestrator and downstream
sub-slices (P2-2 URL extraction, P2-3 photo extraction, P2-4 chat).

Re-exports are added as each implementation chunk lands.
"""

from __future__ import annotations

from extractor.llm.errors import LLM_ERROR_CODES, LLMErrorCode, LLMProviderError

__all__ = [
    "LLM_ERROR_CODES",
    "LLMErrorCode",
    "LLMProviderError",
]
