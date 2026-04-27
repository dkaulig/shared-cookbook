"""AI-chat pipeline (P2-4).

Exports one public coroutine consumed by :mod:`extractor.main`:

- :func:`chat_to_recipe` — structures the full dialogue into a
  :class:`ExtractionResult` via
  :meth:`LLMProvider.extract_structured` with
  :data:`TO_RECIPE_SYSTEM_PROMPT_DE` + :data:`RECIPE_SCHEMA`, then runs
  the defensive :func:`post_process` step from P2-2.

CR5 removed the conversational ``chat_turn`` helper — chat turns are
served natively by the .NET API (Azure OpenAI SSE streaming). Only the
to-recipe conversion lives here now because it reuses the
ExtractionResult shape + post-process pipeline that the rest of the
Python service already owns.

Validation raises pipeline-local exceptions
(:class:`EmptyMessagesError`, :class:`MessagesTooLongError`). The HTTP
layer maps them to 400 / 413; keeping them pipeline-local means unit
tests don't need a FastAPI app to check the rules.

Statelessness: the service keeps **no** session state. ``session_id``
is opaque to the service and flows through only for log correlation +
as a synthetic ``source_url`` ("chat:<id>") on the structured recipe.
"""

from __future__ import annotations

import hashlib
import logging
from collections.abc import Sequence
from typing import Final

from extractor.config_loader import ExtractorConfig, get_flag, get_float, get_int, get_str
from extractor.llm import ChatMessage, LLMProvider, TokenUsage
from extractor.pipeline.post_process import post_process
from extractor.pipeline.types import ConfigSnapshot, ExtractionResult
from extractor.prompts.chat import (
    RECIPE_SCHEMA,
    TO_RECIPE_SYSTEM_PROMPT_DE,
)
from extractor.prompts.language import SupportedLanguage, apply_language_directive

logger = logging.getLogger("extractor.pipeline.chat")

MAX_MESSAGES: Final[int] = 30
"""Upper bound on chat history length.

The plan sets 30 as a safety cap — large enough for realistic recipe
invention dialogues, small enough to protect against runaway prompt
costs + malicious clients flooding the LLM. The HTTP layer maps a
breach to HTTP 413 "zu lang".
"""


class EmptyMessagesError(ValueError):
    """Raised when the caller sent zero messages. HTTP layer → 400."""


class MessagesTooLongError(ValueError):
    """Raised when the caller sent more than :data:`MAX_MESSAGES`. HTTP layer → 413."""


def _validate_messages(messages: Sequence[ChatMessage]) -> None:
    """Reject empty or oversized conversations before the LLM hears about them."""
    if len(messages) == 0:
        raise EmptyMessagesError("messages must not be empty")
    if len(messages) > MAX_MESSAGES:
        raise MessagesTooLongError(
            f"messages too long: got {len(messages)} turns, max {MAX_MESSAGES}"
        )


async def chat_to_recipe(
    messages: Sequence[ChatMessage],
    provider: LLMProvider,
    *,
    session_id: str,
    config: ExtractorConfig | None = None,
    lang: SupportedLanguage = "en",
) -> ExtractionResult:
    """Compress the conversation into a structured recipe.

    Parameters
    ----------
    messages
        Full chat history. Passed as-is to
        :meth:`LLMProvider.extract_structured` — the to-recipe
        prompt treats the dialog as the user message.
    provider
        :class:`LLMProvider`.
    session_id
        Opaque client-provided identifier. Used as the synthetic
        ``source_url`` ("chat:<session_id>") on the structured
        recipe so the downstream UI has a stable reference.
    config
        CFG-1 :class:`ExtractorConfig` — hot params for the
        structured extraction + nutrition flag. ``None`` keeps defaults.

    Raises
    ------
    EmptyMessagesError, MessagesTooLongError, LLMProviderError
        Validation + provider errors bubble up for the HTTP layer
        to classify (400 / 413 / 503 / 500).
    """
    _validate_messages(messages)
    logger.info("chat_to_recipe start session_id=%s turns=%d", session_id, len(messages))

    # CFG-1 — the to-recipe conversion has its own admin-tunable system
    # prompt under ``llm.chat_to_recipe.system_prompt``; the seed
    # populates it with :data:`TO_RECIPE_SYSTEM_PROMPT_DE`. Falling back
    # to the module constant keeps a brand-new DB (or a registry row
    # still on the placeholder seed value) running against the prompt
    # shipped with this extractor release.
    #
    # The deployment / temperature / token-cap knobs still ride on
    # ``llm.structured.*`` because the to-recipe call reuses Azure's
    # structured-extraction shape (json_schema, temperature pin).
    system_prompt_base = await get_str(
        config, "llm.chat_to_recipe.system_prompt", TO_RECIPE_SYSTEM_PROMPT_DE
    )
    # LANG-1 — append the language directive so the chat-to-recipe
    # output (German prose dialog → structured recipe values in the
    # user's UI language) lines up with the rest of the touchpoints.
    # POLISH-1 — Ollama opts into prepend+append redundancy.
    system_prompt = apply_language_directive(
        system_prompt_base,
        lang,
        redundant=provider.requires_redundant_language_directive,
    )
    temperature = await get_float(config, "llm.structured.temperature", 0.0)
    max_completion_tokens = await get_int(config, "llm.structured.max_completion_tokens", 2048)
    deployment = await get_str(config, "llm.structured.deployment", "gpt-4.1-mini")
    nutrition_enabled = await get_flag(config, "feature.nutrition_estimate_enabled", True)
    component_label_max = await get_int(config, "pipeline.component_label_max", 50)

    llm_output, usage = await _call_extract_structured(
        provider,
        system_prompt=system_prompt,
        messages=messages,
        json_schema=RECIPE_SCHEMA,
        temperature=temperature,
        max_completion_tokens=max_completion_tokens,
        deployment=deployment,
    )
    # LANG-1 — hash the base prompt (without per-request language
    # directive). See ``pipeline.url._build_config_snapshot`` for
    # rationale.
    snapshot: ConfigSnapshot = {
        "prompt_hash": (
            "sha256:" + hashlib.sha256(system_prompt_base.encode("utf-8")).hexdigest()[:16]
        ),
        "temperature": temperature,
        "max_completion_tokens": max_completion_tokens,
        "deployment": deployment,
        "prompt_version": (
            config.version_of("llm.chat_to_recipe.system_prompt") if config else None
        ),
    }
    result = post_process(
        llm_output,
        original_url=f"chat:{session_id}",
        usage=usage,
        nutrition_enabled=nutrition_enabled,
        component_label_max=component_label_max,
        config_snapshot=snapshot,
    )
    logger.info("chat_to_recipe done session_id=%s", session_id)
    return result


async def _call_extract_structured(
    provider: LLMProvider,
    *,
    system_prompt: str,
    messages: Sequence[ChatMessage],
    json_schema: dict[str, object],
    temperature: float,
    max_completion_tokens: int,
    deployment: str | None,
) -> tuple[dict[str, object], TokenUsage]:
    """Forward CFG-1 overrides on Azure, drop them for mocks."""
    from extractor.llm.azure_openai import AzureOpenAIProvider

    if isinstance(provider, AzureOpenAIProvider):
        return await provider.extract_structured(
            system_prompt,
            messages,
            json_schema,
            temperature=temperature,
            max_completion_tokens=max_completion_tokens,
            deployment=deployment,
        )
    return await provider.extract_structured(system_prompt, messages, json_schema)


__all__ = [
    "MAX_MESSAGES",
    "EmptyMessagesError",
    "MessagesTooLongError",
    "chat_to_recipe",
]
