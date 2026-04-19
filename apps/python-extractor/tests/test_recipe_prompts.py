"""Tests for the recipe-extraction prompt library.

Covers:
- ``RECIPE_SCHEMA`` is a valid JSON Schema (catches typos at test time).
- ``SYSTEM_PROMPT_DE`` is non-empty and mentions the structured-output
  contract so the LLM doesn't silently drop required fields.
- ``build_user_message`` composes the four source types into one string
  in a stable, labelled order.
"""

from __future__ import annotations

from typing import Any

import jsonschema
import pytest

from extractor.prompts.recipe_extraction import (
    RECIPE_SCHEMA,
    SYSTEM_PROMPT_DE,
    build_user_message,
)


def test_recipe_schema_is_valid_json_schema() -> None:
    """Validates that RECIPE_SCHEMA itself is a well-formed JSON Schema.

    Uses Draft 2020-12 (the default for Azure's structured output).
    """
    # Class-level ``check_schema`` raises ``SchemaError`` on a malformed
    # schema — no exception = valid.
    jsonschema.Draft202012Validator.check_schema(RECIPE_SCHEMA)


def test_recipe_schema_accepts_minimal_valid_payload() -> None:
    """A payload with just the required fields validates cleanly."""
    payload: dict[str, Any] = {
        "title": "Einfaches Rezept",
        "description": None,
        "servings": None,
        "difficulty": None,
        "prep_minutes": None,
        "cook_minutes": None,
        "ingredients": [],
        "steps": [],
        "tags": [],
        "source_url": "https://example.com/rezept",
        "thumbnail_url": None,
    }
    jsonschema.validate(instance=payload, schema=RECIPE_SCHEMA)


def test_recipe_schema_rejects_missing_title() -> None:
    """Missing ``title`` fails validation — it's required."""
    payload: dict[str, Any] = {
        "description": None,
        "servings": None,
        "difficulty": None,
        "prep_minutes": None,
        "cook_minutes": None,
        "ingredients": [],
        "steps": [],
        "tags": [],
        "source_url": "https://example.com/rezept",
        "thumbnail_url": None,
    }
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=payload, schema=RECIPE_SCHEMA)


def test_recipe_schema_rejects_extra_top_level_properties() -> None:
    """additionalProperties: false on the top-level object blocks drift."""
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
        "source_url": "https://example.com/rezept",
        "thumbnail_url": None,
        "bogus_field": "should not be here",
    }
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=payload, schema=RECIPE_SCHEMA)


def test_recipe_schema_validates_full_payload() -> None:
    """Fully populated payload validates."""
    payload = {
        "title": "Kaiserschmarrn",
        "description": "Österreichischer Klassiker.",
        "servings": 4,
        "difficulty": 2,
        "prep_minutes": 10,
        "cook_minutes": 15,
        "ingredients": [
            {
                "name": "Mehl",
                "quantity": "250",
                "unit": "g",
                "note": None,
                "confidence": "high",
            },
            {
                "name": "Rosinen",
                "quantity": None,
                "unit": None,
                "note": "nach Geschmack",
                "confidence": "missing",
            },
        ],
        "steps": [
            {"position": 1, "content": "Teig anrühren.", "confidence": "high"},
            {"position": 2, "content": "In der Pfanne braten.", "confidence": "medium"},
        ],
        "tags": ["dessert", "süß", "klassiker"],
        "source_url": "https://example.com/kaiserschmarrn",
        "thumbnail_url": "https://example.com/kaiserschmarrn.jpg",
    }
    jsonschema.validate(instance=payload, schema=RECIPE_SCHEMA)


def test_recipe_schema_rejects_invalid_confidence_level() -> None:
    """Step confidence must be one of the three literal values."""
    payload = {
        "title": "X",
        "description": None,
        "servings": None,
        "difficulty": None,
        "prep_minutes": None,
        "cook_minutes": None,
        "ingredients": [],
        "steps": [{"position": 1, "content": "do stuff", "confidence": "bogus"}],
        "tags": [],
        "source_url": "https://example.com/x",
        "thumbnail_url": None,
    }
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=payload, schema=RECIPE_SCHEMA)


def test_recipe_schema_rejects_ingredient_without_name() -> None:
    """Ingredient must have a ``name`` — it's the one non-optional field."""
    payload = {
        "title": "X",
        "description": None,
        "servings": None,
        "difficulty": None,
        "prep_minutes": None,
        "cook_minutes": None,
        "ingredients": [
            {
                "quantity": "1",
                "unit": "Stk",
                "note": None,
                "confidence": "high",
            }
        ],
        "steps": [],
        "tags": [],
        "source_url": "https://example.com/x",
        "thumbnail_url": None,
    }
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=payload, schema=RECIPE_SCHEMA)


def test_system_prompt_de_is_non_empty_german() -> None:
    """System prompt exists and names the role in German."""
    assert isinstance(SYSTEM_PROMPT_DE, str)
    assert len(SYSTEM_PROMPT_DE) > 50
    # At least one German domain term appears — keeps the prompt from
    # drifting to generic English by accident.
    assert "Rezept" in SYSTEM_PROMPT_DE


def test_build_user_message_includes_all_sources() -> None:
    """All four source strings appear in the composed message."""
    message = build_user_message(
        transcript="Im Video wird gesagt: Mehl, Eier, Milch.",
        caption="Leckerer Pfannkuchen",
        blog_text="Pfannkuchenrezept von Oma.",
        thumbnail_url="https://example.com/thumb.jpg",
    )
    assert "Mehl, Eier, Milch" in message
    assert "Leckerer Pfannkuchen" in message
    assert "Pfannkuchenrezept von Oma" in message
    assert "https://example.com/thumb.jpg" in message


def test_build_user_message_omits_empty_sections() -> None:
    """When a source is ``None``/empty, the section is skipped cleanly —
    no ``None`` literal bleeds into the prompt."""
    message = build_user_message(
        transcript=None,
        caption=None,
        blog_text="Nur ein Blog-Text.",
        thumbnail_url=None,
    )
    assert "Nur ein Blog-Text" in message
    # Defensive: no stringified None / empty-section leakage.
    assert "None" not in message


def test_build_user_message_returns_non_empty_when_no_sources() -> None:
    """With nothing to work with the helper still returns a string that
    tells the LLM so — never an empty message."""
    message = build_user_message(transcript=None, caption=None, blog_text=None, thumbnail_url=None)
    assert isinstance(message, str)
    assert len(message) > 0


def test_build_user_message_labels_sections() -> None:
    """Each section has a clear label so the LLM can distinguish them."""
    message = build_user_message(
        transcript="T",
        caption="C",
        blog_text="B",
        thumbnail_url="https://example.com/t.jpg",
    )
    # Lower-case to stay tolerant to formatting tweaks.
    lowered = message.lower()
    assert "transkript" in lowered
    assert "caption" in lowered or "beschreibung" in lowered
    assert "blog" in lowered or "webseite" in lowered
    assert "vorschau" in lowered or "thumbnail" in lowered


# ─────────────────────────────────────────────────────────────────────
# Nutrition estimate (P2-10)
# ─────────────────────────────────────────────────────────────────────


def test_recipe_schema_accepts_nutrition_estimate_payload() -> None:
    """Nutrition estimate is optional; when supplied, all four fields
    are integers per portion (kcal/protein_g/carbs_g/fat_g)."""
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
        "source_url": "https://example.com/x",
        "thumbnail_url": None,
        "nutrition_estimate": {
            "kcal": 420,
            "protein_g": 24,
            "carbs_g": 38,
            "fat_g": 9,
        },
    }
    jsonschema.validate(instance=payload, schema=RECIPE_SCHEMA)


def test_recipe_schema_accepts_null_nutrition_estimate() -> None:
    """The field may be explicit ``null`` — means "LLM could not estimate"."""
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
        "source_url": "https://example.com/x",
        "thumbnail_url": None,
        "nutrition_estimate": None,
    }
    jsonschema.validate(instance=payload, schema=RECIPE_SCHEMA)


def test_recipe_schema_accepts_missing_nutrition_estimate() -> None:
    """Back-compat: payloads without the key still validate."""
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
        "source_url": "https://example.com/x",
        "thumbnail_url": None,
    }
    jsonschema.validate(instance=payload, schema=RECIPE_SCHEMA)


def test_recipe_schema_rejects_nutrition_with_extra_field() -> None:
    """The nutrition sub-object is closed — no ``fiber_g`` drift."""
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
        "source_url": "https://example.com/x",
        "thumbnail_url": None,
        "nutrition_estimate": {
            "kcal": 100,
            "protein_g": 1,
            "carbs_g": 1,
            "fat_g": 1,
            "fiber_g": 2,
        },
    }
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=payload, schema=RECIPE_SCHEMA)


def test_recipe_schema_rejects_nutrition_with_missing_required_field() -> None:
    """All four nutrition fields are required inside the object."""
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
        "source_url": "https://example.com/x",
        "thumbnail_url": None,
        "nutrition_estimate": {
            "kcal": 100,
            "protein_g": 10,
            "carbs_g": 10,
            # fat_g missing
        },
    }
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=payload, schema=RECIPE_SCHEMA)


def test_system_prompt_de_requests_nutrition_estimation() -> None:
    """The prompt explicitly asks the LLM to estimate per-portion
    nutrition values when possible — the schema field alone isn't
    enough of a hint for the model to fill it reliably."""
    lowered = SYSTEM_PROMPT_DE.lower()
    assert "nährwert" in lowered or "kalorien" in lowered or "kcal" in lowered
    # Must also mention the per-portion contract.
    assert "portion" in lowered or "pro portion" in lowered
