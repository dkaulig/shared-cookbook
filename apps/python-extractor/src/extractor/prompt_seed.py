"""One-shot system-prompt seeding via the .NET internal endpoint.

CFG-1b — fixes a long-standing wart: the .NET migration seeds the three
``llm.*.system_prompt`` rows with literal ``PLACEHOLDER_*_PROMPT``
strings. Pre-CFG-1b, Python's :mod:`extractor.config_loader` only
*read* the registry and silently fell back to the in-Python default
when it observed the placeholder. The DB row never got rewritten, so
``/admin/extractor`` displayed the raw ``"PLACEHOLDER_..."`` text in
the system-prompt textareas — useless for inspection or editing.

This module runs once at extractor startup, posts the three real
prompts to ``POST /api/internal/extractor-config/seed-prompts``, and
the .NET endpoint replaces any row that *still* carries a
``PLACEHOLDER_*`` value while skipping rows the admin has already
edited (idempotent). The endpoint logs the per-key outcome so a tail
of the extractor log shows ``written/written/skipped`` etc.

Failure mode is *log + continue*: extractor startup never depends on
this seed call succeeding. The .NET API may not be reachable yet at
boot (compose ordering races); the cache TTL of 60 s means Python re-
fetches the config repeatedly anyway, and the next admin edit will
replace any stragglers. Worst case: the admin sees ``"PLACEHOLDER_..."``
for a few minutes after a fresh deploy — same as before this slice
landed, just no permanent regression.
"""

from __future__ import annotations

import logging
from typing import Final

import httpx

from extractor.prompts.chat import TO_RECIPE_SYSTEM_PROMPT_DE
from extractor.prompts.photo_recipe import SYSTEM_PROMPT_DE as PHOTO_SYSTEM_PROMPT_DE
from extractor.prompts.recipe_extraction import SYSTEM_PROMPT_DE as STRUCTURED_SYSTEM_PROMPT_DE

logger = logging.getLogger(__name__)

_SEED_PATH: Final[str] = "/api/internal/extractor-config/seed-prompts"
_SEED_TIMEOUT_SECONDS: Final[float] = 5.0


async def seed_prompts(client: httpx.AsyncClient) -> None:
    """Post the three real system prompts to the .NET seed endpoint.

    Parameters
    ----------
    client
        Pre-built ``httpx.AsyncClient`` whose ``base_url`` points at the
        .NET API (same client the :class:`ExtractorConfig` loader uses
        — sharing it avoids a second TCP/TLS dance at boot).

    Notes
    -----
    The chat key (``llm.chat.system_prompt``) is shown in the admin UI
    for parity with the structured + vision prompts, but the runtime
    chat turn now lives in .NET (``ChatSystemPrompt.BasePrompt`` post
    CR5). The closest in-Python equivalent — and the prompt the
    chat-to-recipe pipeline still ships with — is
    :data:`TO_RECIPE_SYSTEM_PROMPT_DE`. We post that so the admin sees
    a real, German, recipe-oriented system prompt rather than the
    placeholder text. An admin edit on the row is preserved by the
    endpoint's idempotency guard.
    """
    payload = {
        "structured": STRUCTURED_SYSTEM_PROMPT_DE,
        "chat": TO_RECIPE_SYSTEM_PROMPT_DE,
        "vision": PHOTO_SYSTEM_PROMPT_DE,
    }
    try:
        response = await client.post(
            _SEED_PATH,
            json=payload,
            timeout=_SEED_TIMEOUT_SECONDS,
        )
    except httpx.HTTPError as exc:
        # Transport-level failure (connect refused, DNS, TLS). Log +
        # carry on — the cache TTL will retry on every admin edit
        # anyway, and an unreachable .NET at boot is usually a compose-
        # ordering blip that resolves within seconds.
        logger.warning(
            "prompt_seed: post failed err=%s — placeholders may still appear "
            "in the admin UI until the next admin edit.",
            type(exc).__name__,
        )
        return

    if response.status_code >= 400:
        # 4xx/5xx — log the body so an operator can see the error
        # envelope. NOT an exception: the extractor must still boot.
        logger.warning(
            "prompt_seed: endpoint returned status=%d body=%s",
            response.status_code,
            response.text[:500],
        )
        return

    try:
        summary = response.json()
    except ValueError:
        logger.warning(
            "prompt_seed: response was not JSON (status=%d body=%s)",
            response.status_code,
            response.text[:200],
        )
        return

    logger.info(
        "prompt_seed: structured=%s chat=%s vision=%s",
        summary.get("structured", "?"),
        summary.get("chat", "?"),
        summary.get("vision", "?"),
    )


__all__ = ["seed_prompts"]
