"""AI-chat pipeline (P2-4).

Two public coroutines consumed by :mod:`extractor.main` endpoints:

- :func:`chat_turn` — forwards the dialogue to the provider's chat
  method with :data:`CHAT_SYSTEM_PROMPT_DE`. Validates the envelope
  (non-empty, ``<= MAX_MESSAGES`` turns) before hitting the LLM.
- :func:`chat_to_recipe` — structures the full dialogue into a
  :class:`ExtractionResult` via
  :meth:`LLMProvider.extract_structured` with
  :data:`TO_RECIPE_SYSTEM_PROMPT_DE` + :data:`RECIPE_SCHEMA`, then runs
  the defensive :func:`post_process` step from P2-2.

Validation raises pipeline-local exceptions
(:class:`EmptyMessagesError`, :class:`MessagesTooLongError`). The HTTP
layer maps them to 400 / 413; keeping them pipeline-local means unit
tests don't need a FastAPI app to check the rules.

Statelessness: the service keeps **no** session state. ``session_id``
is opaque to the service and flows through only for log correlation +
as a synthetic ``source_url`` ("chat:<id>") on the structured recipe.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from typing import Final

from extractor.llm import ChatMessage, LLMProvider
from extractor.pipeline.post_process import post_process
from extractor.pipeline.types import ExtractionResult
from extractor.prompts.chat import (
    CHAT_SYSTEM_PROMPT_DE,
    RECIPE_SCHEMA,
    TO_RECIPE_SYSTEM_PROMPT_DE,
)

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
            f"messages zu lang: got {len(messages)} turns, max {MAX_MESSAGES}"
        )


async def chat_turn(
    messages: Sequence[ChatMessage],
    provider: LLMProvider,
) -> str:
    """Run one conversational turn and return the assistant's reply.

    Parameters
    ----------
    messages
        Full conversation history the client is maintaining — the
        service is stateless, so every turn ships the full array.
    provider
        :class:`LLMProvider` (real Azure or a mock).

    Raises
    ------
    EmptyMessagesError
        ``messages`` was empty. Maps to HTTP 400.
    MessagesTooLongError
        Too many turns. Maps to HTTP 413.
    LLMProviderError
        The provider raised; re-raised unchanged for the HTTP layer
        to classify (503 / 500).
    """
    _validate_messages(messages)
    # User content stays out of INFO logs — turn count is enough for
    # operational visibility.
    logger.info("chat_turn start turns=%d", len(messages))
    reply, _usage = await provider.chat(
        system_prompt=CHAT_SYSTEM_PROMPT_DE,
        messages=messages,
    )
    logger.info("chat_turn done reply_len=%d", len(reply))
    return reply


async def chat_to_recipe(
    messages: Sequence[ChatMessage],
    provider: LLMProvider,
    *,
    session_id: str,
) -> ExtractionResult:
    """Verdichte die Konversation zu einem strukturierten Rezept.

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

    Raises
    ------
    EmptyMessagesError, MessagesTooLongError, LLMProviderError
        Same semantics as :func:`chat_turn`.
    """
    _validate_messages(messages)
    logger.info("chat_to_recipe start session_id=%s turns=%d", session_id, len(messages))
    llm_output, _usage = await provider.extract_structured(
        system_prompt=TO_RECIPE_SYSTEM_PROMPT_DE,
        messages=messages,
        json_schema=RECIPE_SCHEMA,
    )
    result = post_process(
        llm_output,
        original_url=f"chat:{session_id}",
        fallback_thumbnail=None,
    )
    logger.info("chat_to_recipe done session_id=%s", session_id)
    return result


__all__ = [
    "MAX_MESSAGES",
    "EmptyMessagesError",
    "MessagesTooLongError",
    "chat_to_recipe",
    "chat_turn",
]
