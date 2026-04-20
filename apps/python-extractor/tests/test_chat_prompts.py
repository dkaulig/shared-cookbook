"""Tests for the chat-to-recipe prompt library.

Pins the German "verdichte Dialog" to-recipe prompt so accidental edits
break loudly. Also confirms the module re-exports :data:`RECIPE_SCHEMA`
from P2-2 so the structuring call shares the exact same schema (single
source of truth — no parallel schema drift).

CR5 removed the conversational system prompt — chat turns are served
by the .NET API now. Only the to-recipe prompt remains here.
"""

from __future__ import annotations

from extractor.prompts.chat import (
    RECIPE_SCHEMA,
    TO_RECIPE_SYSTEM_PROMPT_DE,
)
from extractor.prompts.recipe_extraction import RECIPE_SCHEMA as CANONICAL_RECIPE_SCHEMA


def test_to_recipe_system_prompt_is_non_empty_german() -> None:
    """To-recipe prompt exists, frames the 'verdichten' task in German."""
    assert isinstance(TO_RECIPE_SYSTEM_PROMPT_DE, str)
    assert len(TO_RECIPE_SYSTEM_PROMPT_DE) > 50
    lowered = TO_RECIPE_SYSTEM_PROMPT_DE.lower()
    # Plan language: "Verdichte Dialog zu strukturiertem JSON-Rezept".
    assert "dialog" in lowered
    assert "json" in lowered
    assert "rezept" in lowered


def test_recipe_schema_is_reused_from_p2_2() -> None:
    """``chat.RECIPE_SCHEMA`` is the *same object* the URL pipeline uses.

    Re-export — not a copy. If a future PR duplicates the schema by
    mistake, this identity check fails.
    """
    assert RECIPE_SCHEMA is CANONICAL_RECIPE_SCHEMA
