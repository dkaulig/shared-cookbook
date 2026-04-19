"""Test-time substitutes for ``LLMProvider``.

Two implementations live here because they share the same intent (keep
real Azure calls out of CI) and the same base class:

- ``MockLLMProvider`` — scripted dict of pre-canned replies. Tests key
  replies on a stable hash of the request so the script mirrors
  real-world inputs and typos are caught.
- ``NullProvider`` — raises on every call. Returned by the factory when
  ``AZURE_OPENAI_API_KEY`` is empty, so a misconfigured deploy surfaces
  the problem at the first call site instead of silently succeeding.

Every method returns ``(result, TokenUsage)``. For
:class:`MockLLMProvider` the default usage is
``TokenUsage(0, 0, 0, "mock")`` so tests that don't care about
accounting keep scripting a bare payload. Tests that *do* care can
script an expanded tuple ``(payload, usage)`` on the same key so the
mock returns the scripted usage instead of the zero default.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Sequence
from typing import Any

from extractor.llm.errors import LLMProviderError
from extractor.llm.provider import ChatMessage, LLMProvider, TokenUsage, VisionInput

# Default :class:`TokenUsage` the mock returns when a scripted entry
# only carries a bare payload. Zero counts + the ``"mock"`` model name
# mean downstream tests that *do* care about header propagation can
# still distinguish mock-driven responses from real ones.
_DEFAULT_MOCK_USAGE: TokenUsage = {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "cached_prompt_tokens": 0,
    "model": "mock",
}


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


def _split_scripted_entry(
    entry: Any,
    *,
    expected_payload_type: type,
    context: str,
) -> tuple[Any, TokenUsage]:
    """Unpack a scripted entry into ``(payload, usage)``.

    Tests may script either the bare payload (backwards-compatible: the
    mock pairs it with :data:`_DEFAULT_MOCK_USAGE`) or a 2-tuple
    ``(payload, usage)`` pinning explicit token counts. Anything else
    raises ``not_configured`` so forgotten scripts fail loud.
    """
    if isinstance(entry, tuple) and len(entry) == 2:
        payload, usage = entry
        if not isinstance(payload, expected_payload_type):
            raise LLMProviderError(
                f"MockLLMProvider: scripted {context} payload must be "
                f"a {expected_payload_type.__name__}",
                code="not_configured",
            )
        if not isinstance(usage, dict):
            raise LLMProviderError(
                f"MockLLMProvider: scripted {context} usage must be a dict / TokenUsage",
                code="not_configured",
            )
        return payload, _as_token_usage(usage)
    if not isinstance(entry, expected_payload_type):
        raise LLMProviderError(
            f"MockLLMProvider: scripted {context} reply must be a "
            f"{expected_payload_type.__name__}",
            code="not_configured",
        )
    # Fresh copy of the default so test assertions over `is` still
    # detect mutation rather than silently sharing a module singleton.
    default_usage: TokenUsage = {
        "prompt_tokens": _DEFAULT_MOCK_USAGE["prompt_tokens"],
        "completion_tokens": _DEFAULT_MOCK_USAGE["completion_tokens"],
        "cached_prompt_tokens": _DEFAULT_MOCK_USAGE["cached_prompt_tokens"],
        "model": _DEFAULT_MOCK_USAGE["model"],
    }
    return entry, default_usage


def _as_token_usage(raw: dict[str, Any]) -> TokenUsage:
    """Normalise a dict into a :class:`TokenUsage`, filling defaults."""
    prompt = raw.get("prompt_tokens", 0)
    completion = raw.get("completion_tokens", 0)
    cached = raw.get("cached_prompt_tokens", 0)
    model = raw.get("model", "mock")
    if not (isinstance(prompt, int) and isinstance(completion, int) and isinstance(cached, int)):
        raise LLMProviderError(
            "MockLLMProvider: scripted TokenUsage counts must be ints",
            code="not_configured",
        )
    if not isinstance(model, str) or not model:
        raise LLMProviderError(
            "MockLLMProvider: scripted TokenUsage model must be a non-empty str",
            code="not_configured",
        )
    return {
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "cached_prompt_tokens": cached,
        "model": model,
    }


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
    ) -> tuple[dict[str, Any], TokenUsage]:
        key = make_script_key(system_prompt=system_prompt, messages=messages)
        if key not in self._scripted:
            raise LLMProviderError(
                "MockLLMProvider: no scripted reply for extract_structured input",
                code="not_configured",
            )
        payload, usage = _split_scripted_entry(
            self._scripted[key],
            expected_payload_type=dict,
            context="extract_structured",
        )
        # Explicit cast through a fresh dict guarantees the caller can't
        # mutate the script between tests.
        return dict(payload), usage

    async def chat(
        self,
        system_prompt: str,
        messages: Sequence[ChatMessage],
    ) -> tuple[str, TokenUsage]:
        key = make_script_key(system_prompt=system_prompt, messages=messages)
        if key not in self._scripted:
            raise LLMProviderError(
                "MockLLMProvider: no scripted reply for chat input",
                code="not_configured",
            )
        payload, usage = _split_scripted_entry(
            self._scripted[key],
            expected_payload_type=str,
            context="chat",
        )
        return payload, usage

    async def vision_extract(
        self,
        system_prompt: str,
        images: Sequence[VisionInput],
        instruction: str,
        json_schema: dict[str, Any],
    ) -> tuple[dict[str, Any], TokenUsage]:
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
        payload, usage = _split_scripted_entry(
            self._scripted[key],
            expected_payload_type=dict,
            context="vision_extract",
        )
        return dict(payload), usage


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
    ) -> tuple[dict[str, Any], TokenUsage]:
        raise LLMProviderError(self._MESSAGE, code="not_configured")

    async def chat(
        self,
        system_prompt: str,
        messages: Sequence[ChatMessage],
    ) -> tuple[str, TokenUsage]:
        raise LLMProviderError(self._MESSAGE, code="not_configured")

    async def vision_extract(
        self,
        system_prompt: str,
        images: Sequence[VisionInput],
        instruction: str,
        json_schema: dict[str, Any],
    ) -> tuple[dict[str, Any], TokenUsage]:
        raise LLMProviderError(self._MESSAGE, code="not_configured")
