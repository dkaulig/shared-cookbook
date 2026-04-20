"""Prompt library for the chat-to-recipe conversion flow.

One German system prompt lives here: :data:`TO_RECIPE_SYSTEM_PROMPT_DE`
runs over the full chat history with :data:`RECIPE_SCHEMA` (reused from
:mod:`extractor.prompts.recipe_extraction` — one source of truth for
the schema shape so URL + photos + chat-to-recipe pipelines cannot
drift).

CR5 removed the conversational system prompt (``CHAT_SYSTEM_PROMPT_DE``)
from this module — the .NET API now owns the chat turn and has its own
copy at ``apps/api/src/FamilienKochbuch.Api/Services/ChatSystemPrompt.cs``
(ported verbatim from the German original).

Reuse (not duplicate): :data:`RECIPE_SCHEMA` is re-exported from
:mod:`extractor.prompts.recipe_extraction`. A test pins object identity.
"""

from __future__ import annotations

from typing import Final

from extractor.prompts.recipe_extraction import RECIPE_SCHEMA

TO_RECIPE_SYSTEM_PROMPT_DE: Final[str] = (
    "Verdichte den vorliegenden Dialog zu einem strukturierten "
    "JSON-Rezept, das dem Schema folgt. Beziehe dich ausschließlich "
    "auf das, was im Dialog besprochen wurde — erfinde keine "
    "Zutaten, Mengen oder Schritte. Portionen, Zeiten und "
    "Zutaten-Mengen möglichst konkret; fehlt eine Angabe, nutze "
    "sinnvolle Defaults (4 Portionen, realistische Minuten). "
    "Für Zutaten ohne erkennbare Menge setze `quantity` auf null "
    'und `confidence` auf "missing". Die Sprache der Ausgabe ist '
    "Deutsch."
)


__all__ = [
    "RECIPE_SCHEMA",
    "TO_RECIPE_SYSTEM_PROMPT_DE",
]
