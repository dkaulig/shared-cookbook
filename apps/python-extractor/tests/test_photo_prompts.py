"""Tests for the photo-extraction prompt library (P2-3).

Covers:
- ``PHOTO_RECIPE_SCHEMA`` is a valid JSON Schema that mirrors
  :data:`RECIPE_SCHEMA` *and* adds ``"handwritten_uncertain"`` as an
  allowed ingredient / step confidence literal (paper cookbook cards
  need a finer-grained unknown).
- ``SYSTEM_PROMPT_DE`` names the digitiser role + German handwriting +
  preserves old German units.
- ``build_photo_instruction`` produces a deterministic string that
  mentions the photo count and the reading order.
"""

from __future__ import annotations

from typing import Any

import jsonschema
import pytest

from extractor.prompts.photo_recipe import (
    PHOTO_RECIPE_SCHEMA,
    SYSTEM_PROMPT_DE,
    build_photo_instruction,
)

# ─────────────────────────────────────────────────────────────────────
# System prompt
# ─────────────────────────────────────────────────────────────────────


def test_system_prompt_de_names_role_and_handwriting() -> None:
    """Prompt establishes the digitiser role + handwriting + old-units rule.

    These four bits of text are the contract with the Vision-LLM: drop
    any and handwriting recipes start drifting to modern-unit English
    translations in real-world tests. Pinned here so any future edit
    surfaces in CI.
    """
    assert isinstance(SYSTEM_PROMPT_DE, str)
    assert len(SYSTEM_PROMPT_DE) > 80
    lowered = SYSTEM_PROMPT_DE.lower()
    assert "rezept" in lowered
    # Handwriting hint — "handschrift" is the load-bearing term.
    assert "handschrift" in lowered
    # Old-unit preservation must be explicit ("Tasse" / "Prise" etc.).
    assert "tasse" in lowered or "prise" in lowered
    # The confidence marker the schema exposes must also appear in the
    # instruction so the LLM knows when to set it.
    assert "handwritten_uncertain" in SYSTEM_PROMPT_DE


# ─────────────────────────────────────────────────────────────────────
# build_photo_instruction
# ─────────────────────────────────────────────────────────────────────


def test_build_photo_instruction_names_single_photo() -> None:
    message = build_photo_instruction(1)
    assert isinstance(message, str)
    assert "1" in message
    # German label; also names the reading direction so the LLM knows
    # it's a multi-page sequence, not independent recipes.
    lowered = message.lower()
    assert "foto" in lowered
    assert "seite" in lowered


def test_build_photo_instruction_scales_with_count() -> None:
    """The digit embedded in the instruction matches the argument."""
    msg3 = build_photo_instruction(3)
    assert "3" in msg3
    assert "Seite 1" in msg3
    assert "Seite 3" in msg3


def test_build_photo_instruction_rejects_non_positive() -> None:
    """Defensive: the pipeline layer validates 1..10 but the prompt
    helper should also refuse a zero or negative count — a bug in
    the caller would otherwise produce a nonsensical ``"0 Fotos"``
    message."""
    with pytest.raises(ValueError):
        build_photo_instruction(0)
    with pytest.raises(ValueError):
        build_photo_instruction(-2)


# ─────────────────────────────────────────────────────────────────────
# PHOTO_RECIPE_SCHEMA
# ─────────────────────────────────────────────────────────────────────


def test_photo_recipe_schema_is_valid_json_schema() -> None:
    jsonschema.Draft202012Validator.check_schema(PHOTO_RECIPE_SCHEMA)


def test_photo_recipe_schema_accepts_minimal_payload() -> None:
    payload: dict[str, Any] = {
        "title": "Omas Kaiserschmarrn",
        "description": None,
        "servings": None,
        "difficulty": None,
        "prep_minutes": None,
        "cook_minutes": None,
        "ingredients": [],
        "steps": [],
        "tags": [],
        "source_url": "photos://upload",
        "thumbnail_url": None,
    }
    jsonschema.validate(instance=payload, schema=PHOTO_RECIPE_SCHEMA)


def test_photo_recipe_schema_accepts_handwritten_uncertain_ingredient() -> None:
    """The photo schema's ingredient confidence enum adds the extra
    literal — the LLM flags blurry / ambiguous handwriting rows with
    it and the pipeline preserves it verbatim."""
    payload: dict[str, Any] = {
        "title": "Omas Kuchen",
        "description": None,
        "servings": None,
        "difficulty": None,
        "prep_minutes": None,
        "cook_minutes": None,
        "ingredients": [
            {
                "name": "Rosinen",
                "quantity": "eine",
                "unit": "Tasse",
                "note": None,
                "confidence": "handwritten_uncertain",
            }
        ],
        "steps": [],
        "tags": [],
        "source_url": "photos://upload",
        "thumbnail_url": None,
    }
    jsonschema.validate(instance=payload, schema=PHOTO_RECIPE_SCHEMA)


def test_photo_recipe_schema_accepts_handwritten_uncertain_step() -> None:
    """Steps also get the extra literal — an illegible step row
    is still a step, just flagged for manual review."""
    payload: dict[str, Any] = {
        "title": "Omas Rezept",
        "description": None,
        "servings": None,
        "difficulty": None,
        "prep_minutes": None,
        "cook_minutes": None,
        "ingredients": [],
        "steps": [
            {
                "position": 1,
                "content": "Teig kurz ruhen lassen (unleserlich).",
                "confidence": "handwritten_uncertain",
            }
        ],
        "tags": [],
        "source_url": "photos://upload",
        "thumbnail_url": None,
    }
    jsonschema.validate(instance=payload, schema=PHOTO_RECIPE_SCHEMA)


def test_photo_recipe_schema_still_accepts_classic_confidences() -> None:
    """The extension must not drop ``high`` / ``medium`` / ``low`` —
    the LLM uses those for print-style photos."""
    payload: dict[str, Any] = {
        "title": "Kuchen",
        "description": None,
        "servings": None,
        "difficulty": None,
        "prep_minutes": None,
        "cook_minutes": None,
        "ingredients": [
            {
                "name": "Mehl",
                "quantity": "250",
                "unit": "g",
                "note": None,
                "confidence": "high",
            },
        ],
        "steps": [
            {"position": 1, "content": "Teig kneten.", "confidence": "medium"},
        ],
        "tags": [],
        "source_url": "photos://upload",
        "thumbnail_url": None,
    }
    jsonschema.validate(instance=payload, schema=PHOTO_RECIPE_SCHEMA)


def test_photo_recipe_schema_rejects_bogus_confidence() -> None:
    """Sanity: an unknown literal still fails. Guards against a typo
    silently becoming the new default."""
    payload: dict[str, Any] = {
        "title": "X",
        "description": None,
        "servings": None,
        "difficulty": None,
        "prep_minutes": None,
        "cook_minutes": None,
        "ingredients": [],
        "steps": [
            {"position": 1, "content": "X", "confidence": "kaputt"},
        ],
        "tags": [],
        "source_url": "photos://upload",
        "thumbnail_url": None,
    }
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=payload, schema=PHOTO_RECIPE_SCHEMA)


def test_photo_recipe_schema_rejects_extra_properties() -> None:
    """additionalProperties: false blocks silent drift at the top level."""
    payload: dict[str, Any] = {
        "title": "X",
        "description": None,
        "servings": None,
        "difficulty": None,
        "prep_minutes": None,
        "cook_minutes": None,
        "ingredients": [],
        "steps": [],
        "tags": [],
        "source_url": "photos://upload",
        "thumbnail_url": None,
        "bogus": "x",
    }
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=payload, schema=PHOTO_RECIPE_SCHEMA)


def test_photo_recipe_schema_does_not_mutate_base_recipe_schema() -> None:
    """Extending the base schema by reference would corrupt the URL
    pipeline's confidence enum for the rest of the process. Guard
    against that by re-validating a URL-path payload with
    ``confidence="handwritten_uncertain"`` against the *base* schema —
    it must be rejected there."""
    from extractor.prompts.recipe_extraction import RECIPE_SCHEMA

    payload: dict[str, Any] = {
        "title": "X",
        "description": None,
        "servings": None,
        "difficulty": None,
        "prep_minutes": None,
        "cook_minutes": None,
        "ingredients": [
            {
                "name": "X",
                "quantity": None,
                "unit": None,
                "note": None,
                "confidence": "handwritten_uncertain",
            }
        ],
        "steps": [],
        "tags": [],
        "source_url": "https://example.com/x",
        "thumbnail_url": None,
    }
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=payload, schema=RECIPE_SCHEMA)
