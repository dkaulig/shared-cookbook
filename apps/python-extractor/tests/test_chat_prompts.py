"""Tests for the AI-chat prompt library (P2-4).

Pins the German chat system prompt + the "verdichte Dialog" to-recipe
prompt so accidental edits break loudly. Also confirms the to-recipe
module re-exports :data:`RECIPE_SCHEMA` from P2-2 so the structuring
call shares the exact same schema (single source of truth — no parallel
schema drift).
"""

from __future__ import annotations

from extractor.prompts.chat import (
    CHAT_SYSTEM_PROMPT_DE,
    RECIPE_SCHEMA,
    TO_RECIPE_SYSTEM_PROMPT_DE,
)
from extractor.prompts.recipe_extraction import RECIPE_SCHEMA as CANONICAL_RECIPE_SCHEMA


def test_chat_system_prompt_is_non_empty_german() -> None:
    """Chat system prompt exists and names the koch-assistent role in German."""
    assert isinstance(CHAT_SYSTEM_PROMPT_DE, str)
    assert len(CHAT_SYSTEM_PROMPT_DE) > 50
    lowered = CHAT_SYSTEM_PROMPT_DE.lower()
    # Role framing + short-reply rule + clarifying-questions hint.
    assert "koch" in lowered
    # The prompt should mention the clarifying-question categories from
    # the plan. Covers allergies, portions, time.
    assert "allerg" in lowered
    assert "portion" in lowered
    assert "zeit" in lowered


def test_chat_system_prompt_avoids_json_instruction() -> None:
    """Chat turn is a conversation — JSON structuring is a separate step.

    The prompt must NOT tell the model to reply in JSON; otherwise the
    user sees raw JSON in the chat bubble instead of prose.
    """
    assert "JSON" not in CHAT_SYSTEM_PROMPT_DE


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
