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
        "nutrition_estimate": None,
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
        "nutrition_estimate": None,
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
        "nutrition_estimate": None,
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
        "nutrition_estimate": None,
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
        "nutrition_estimate": None,
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
        "nutrition_estimate": None,
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


def test_recipe_schema_rejects_missing_nutrition_estimate() -> None:
    """Azure Responses-API strict mode (2025-04) requires every
    ``properties`` key in ``required`` — omitting ``nutrition_estimate``
    now fails validation. Callers must pass the key explicitly (``null``
    is accepted because the field is typed ``["object", "null"]``)."""
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
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=payload, schema=RECIPE_SCHEMA)


def test_recipe_schema_requires_nutrition_estimate() -> None:
    """Regression guard for the Azure strict-mode fix.

    Azure Responses API (strict schema, 2025-04) rejects any
    ``response_format`` JSON schema that has a ``properties`` key absent
    from ``required``. The schema keeps ``nutrition_estimate`` nullable
    via ``type: ["object", "null"]`` so the LLM can still signal "no
    estimate possible" by emitting ``null``."""
    assert "nutrition_estimate" in RECIPE_SCHEMA["required"]
    assert "nutrition_estimate" in RECIPE_SCHEMA["properties"]
    assert "null" in RECIPE_SCHEMA["properties"]["nutrition_estimate"]["type"]
    # Defensive: every declared property is listed in required — this
    # mirrors the Azure strict-mode invariant for the whole schema, not
    # just ``nutrition_estimate``.
    assert set(RECIPE_SCHEMA["required"]) == set(RECIPE_SCHEMA["properties"].keys())


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


# ─────────────────────────────────────────────────────────────────────
# BUG-028 prompt-regression gates — quantity routing rule
# ─────────────────────────────────────────────────────────────────────


def test_system_prompt_forbids_mass_in_description() -> None:
    """The BUG-028 prompt-hardening paragraph must mention `description`,
    `quantity` and the hard-NO marker `NIEMALS` within a 400-char window
    of each other (the same paragraph). The prompt has multiple
    occurrences of each keyword — we look for the tightest window
    containing all three. Grep-style guard so any future edit that drops
    the rule surfaces in CI."""
    text = SYSTEM_PROMPT_DE

    def all_indices(needle: str) -> list[int]:
        out: list[int] = []
        start = 0
        while True:
            idx = text.find(needle, start)
            if idx < 0:
                return out
            out.append(idx)
            start = idx + 1

    desc = all_indices("description")
    quant = all_indices("quantity")
    niemals = all_indices("NIEMALS")
    assert desc, "prompt missing the word 'description'"
    assert quant, "prompt missing the word 'quantity'"
    assert niemals, "prompt missing the hard-NO marker 'NIEMALS'"
    tightest = min(max(d, q, n) - min(d, q, n) for d in desc for q in quant for n in niemals)
    assert tightest <= 400, (
        f"description/quantity/NIEMALS too far apart ({tightest} chars) — "
        "the BUG-028 paragraph likely got split or dropped"
    )


def test_system_prompt_calls_description_a_summary() -> None:
    """The BUG-022 prompt-hardening paragraph must call `description` a
    short summary (Zusammenfassung / knapp) — within 200 chars of the
    word `description`."""
    text = SYSTEM_PROMPT_DE
    desc_idx = text.find("description")
    assert desc_idx >= 0, "prompt missing the word 'description'"
    window = text[max(0, desc_idx - 200) : desc_idx + 200].lower()
    assert "zusammenfassung" in window or "knapp" in window, (
        "the BUG-022 paragraph must describe `description` as a "
        "Zusammenfassung / knapp summary near the field name"
    )


# ─────────────────────────────────────────────────────────────────────
# BUG-030 — imperial → metric / German prompt directive
# ─────────────────────────────────────────────────────────────────────


def test_system_prompt_includes_imperial_to_metric_conversion() -> None:
    """BUG-030: the prompt must name the metric-only rule AND list the
    imperial tokens alongside their German targets. Regression guard so
    a future edit that drops the paragraph surfaces in CI."""
    assert "metrisch" in SYSTEM_PROMPT_DE
    # Grep for the imperial units + their conversions in close proximity.
    for token in ("oz", "cup", "tbsp", "tsp", "clove", "Zehe"):
        assert token in SYSTEM_PROMPT_DE, f"prompt missing token {token!r}"
