"""Prompt library for the P2-4 AI-chat flow.

Two German-first system prompts live here — one for conversational
turns, one for "Dialog → strukturiertes JSON-Rezept" conversion.

- :data:`CHAT_SYSTEM_PROMPT_DE` frames the assistant as a koch-assistent
  that keeps replies short and asks clarifying questions (allergies,
  portions, time). Crucially, it does NOT tell the model to reply in
  JSON — the JSON-structuring call is a separate step driven by the
  to-recipe prompt.
- :data:`TO_RECIPE_SYSTEM_PROMPT_DE` runs over the full chat history
  with :data:`RECIPE_SCHEMA` (reused from :mod:`extractor.prompts.recipe_extraction`
  — one source of truth for the schema shape so URL + photos + chat
  pipelines cannot drift).

Reuse (not duplicate): :data:`RECIPE_SCHEMA` is re-exported from
:mod:`extractor.prompts.recipe_extraction`. A test pins object identity.
"""

from __future__ import annotations

from typing import Final

from extractor.prompts.recipe_extraction import RECIPE_SCHEMA

CHAT_SYSTEM_PROMPT_DE: Final[str] = (
    "Du bist ein hilfreicher Koch-Assistent. "
    "Halte dich kurz und frage bei Bedarf präzise Rückfragen — "
    "zum Beispiel zu Allergien, Portionen oder gewünschter Zeit. "
    "Wenn der Nutzer ein konkretes Rezept möchte, formuliere es "
    "fließend in deutscher Sprache, aber nicht im strukturierten "
    "Format; die Verdichtung zu einem Rezept übernimmt ein "
    "separater Schritt."
)

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
    "CHAT_SYSTEM_PROMPT_DE",
    "RECIPE_SCHEMA",
    "TO_RECIPE_SYSTEM_PROMPT_DE",
]
