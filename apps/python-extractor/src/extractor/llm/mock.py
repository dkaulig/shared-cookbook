"""Test-time substitutes for ``LLMProvider``.

Two implementations live here because they share the same intent (keep
real Azure calls out of CI) and the same base class:

- ``MockLLMProvider`` — scripted dict of pre-canned replies. Tests key
  replies on a stable hash of the request so the script mirrors
  real-world inputs and typos are caught.
- ``NullProvider`` — raises on every call. Returned by the factory when
  ``AZURE_OPENAI_API_KEY`` is empty, so a misconfigured deploy surfaces
  the problem at the first call site instead of silently succeeding.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Sequence
from typing import Any

from extractor.llm.errors import LLMProviderError
from extractor.llm.provider import ChatMessage, LLMProvider, VisionInput


def make_script_key(
    *,
    system_prompt: str,
    messages: Sequence[ChatMessage],
    extra: tuple[str, ...] | None = None,
) -> str:
    """Build a deterministic key from a request's shape.

    Tests build the same key when seeding the script. ``extra`` carries
    the vision-specific fields (image URLs + detail levels + the
    instruction text) so chat/extract/vision share one key scheme
    without colliding.

    SHA-256 over a canonical JSON serialisation — stable across Python
    versions + deterministic ordering via ``sort_keys`` on any dicts
    embedded in message content (content is a plain str today, but
    sort_keys costs nothing and future-proofs against structured
    content arrays).
    """
    payload: dict[str, Any] = {
        "system": system_prompt,
        "messages": [dict(m) for m in messages],
    }
    if extra is not None:
        payload["extra"] = list(extra)
    encoded = json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")
    # S324: blake2b / sha256 both fine here; this isn't a cryptographic
    # context, it's a test-script lookup. Use sha256 for readability.
    return hashlib.sha256(encoded).hexdigest()


class MockLLMProvider(LLMProvider):
    """Scripted provider for tests. Raises ``not_configured`` on misses."""

    def __init__(self, scripted: dict[str, Any] | None = None) -> None:
        # Keep the scripted table on the instance, not the class, so
        # parallel tests don't share state.
        self._scripted: dict[str, Any] = dict(scripted or {})

    async def extract_structured(
        self,
        system_prompt: str,
        messages: Sequence[ChatMessage],
        json_schema: dict[str, Any],
    ) -> dict[str, Any]:
        key = make_script_key(system_prompt=system_prompt, messages=messages)
        if key not in self._scripted:
            raise LLMProviderError(
                "MockLLMProvider: no scripted reply for extract_structured input",
                code="not_configured",
            )
        result = self._scripted[key]
        if not isinstance(result, dict):
            raise LLMProviderError(
                "MockLLMProvider: scripted extract_structured reply must be a dict",
                code="not_configured",
            )
        # Explicit cast through a fresh dict guarantees the caller can't
        # mutate the script between tests.
        return dict(result)

    async def chat(
        self,
        system_prompt: str,
        messages: Sequence[ChatMessage],
    ) -> str:
        key = make_script_key(system_prompt=system_prompt, messages=messages)
        if key not in self._scripted:
            raise LLMProviderError(
                "MockLLMProvider: no scripted reply for chat input",
                code="not_configured",
            )
        result = self._scripted[key]
        if not isinstance(result, str):
            raise LLMProviderError(
                "MockLLMProvider: scripted chat reply must be a str",
                code="not_configured",
            )
        return result

    async def vision_extract(
        self,
        system_prompt: str,
        images: Sequence[VisionInput],
        instruction: str,
        json_schema: dict[str, Any],
    ) -> dict[str, Any]:
        # Vision calls collapse images + instruction into `extra` so
        # chat/extract/vision use one key scheme.
        extra_parts: list[str] = ["vision"]
        for image in images:
            extra_parts.extend([image["image_url"], image["detail"]])
        key = make_script_key(
            system_prompt=system_prompt,
            messages=[{"role": "user", "content": instruction}],
            extra=tuple(extra_parts),
        )
        if key not in self._scripted:
            raise LLMProviderError(
                "MockLLMProvider: no scripted reply for vision_extract input",
                code="not_configured",
            )
        result = self._scripted[key]
        if not isinstance(result, dict):
            raise LLMProviderError(
                "MockLLMProvider: scripted vision_extract reply must be a dict",
                code="not_configured",
            )
        return dict(result)


class NullProvider(LLMProvider):
    """Always-failing provider. Returned when credentials are missing.

    Any call surfaces ``LLMProviderError(code="not_configured")`` with a
    message that names ``AZURE_OPENAI_API_KEY`` so ops can fix without
    reading code.
    """

    _MESSAGE = (
        "LLM provider not configured: AZURE_OPENAI_API_KEY is empty. "
        "Set the env var to enable the Azure OpenAI provider."
    )

    async def extract_structured(
        self,
        system_prompt: str,
        messages: Sequence[ChatMessage],
        json_schema: dict[str, Any],
    ) -> dict[str, Any]:
        raise LLMProviderError(self._MESSAGE, code="not_configured")

    async def chat(
        self,
        system_prompt: str,
        messages: Sequence[ChatMessage],
    ) -> str:
        raise LLMProviderError(self._MESSAGE, code="not_configured")

    async def vision_extract(
        self,
        system_prompt: str,
        images: Sequence[VisionInput],
        instruction: str,
        json_schema: dict[str, Any],
    ) -> dict[str, Any]:
        raise LLMProviderError(self._MESSAGE, code="not_configured")
