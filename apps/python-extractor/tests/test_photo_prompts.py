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


def _photo_default_component(
    *,
    ingredients: list[dict[str, Any]] | None = None,
    steps: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """COMP-1 test helper — a default component for the photo schema.

    Mirrors the helper in ``test_recipe_prompts.py``; lives here as a
    local copy so the photo tests stay import-independent.
    """
    return {
        "label": None,
        "position": 0,
        "ingredients": ingredients if ingredients is not None else [],
        "steps": steps if steps is not None else [],
    }


def test_photo_recipe_schema_accepts_minimal_payload() -> None:
    payload: dict[str, Any] = {
        "title": "Omas Kaiserschmarrn",
        "description": None,
        "servings": None,
        "difficulty": None,
        "prep_minutes": None,
        "cook_minutes": None,
        "components": [_photo_default_component()],
        "tags": [],
        "source_url": "photos://upload",
        "thumbnail_url": None,
        "nutrition_estimate": None,
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
        "components": [
            _photo_default_component(
                ingredients=[
                    {
                        "name": "Rosinen",
                        "quantity": "eine",
                        "unit": "Tasse",
                        "note": None,
                        "confidence": "handwritten_uncertain",
                    }
                ],
            )
        ],
        "tags": [],
        "source_url": "photos://upload",
        "thumbnail_url": None,
        "nutrition_estimate": None,
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
        "components": [
            _photo_default_component(
                steps=[
                    {
                        "position": 1,
                        "content": "Teig kurz ruhen lassen (unleserlich).",
                        "confidence": "handwritten_uncertain",
                    }
                ],
            )
        ],
        "tags": [],
        "source_url": "photos://upload",
        "thumbnail_url": None,
        "nutrition_estimate": None,
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
        "components": [
            _photo_default_component(
                ingredients=[
                    {
                        "name": "Mehl",
                        "quantity": "250",
                        "unit": "g",
                        "note": None,
                        "confidence": "high",
                    },
                ],
                steps=[
                    {"position": 1, "content": "Teig kneten.", "confidence": "medium"},
                ],
            )
        ],
        "tags": [],
        "source_url": "photos://upload",
        "thumbnail_url": None,
        "nutrition_estimate": None,
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
        "components": [
            _photo_default_component(
                steps=[
                    {"position": 1, "content": "X", "confidence": "kaputt"},
                ],
            )
        ],
        "tags": [],
        "source_url": "photos://upload",
        "thumbnail_url": None,
        "nutrition_estimate": None,
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
        "components": [_photo_default_component()],
        "tags": [],
        "source_url": "photos://upload",
        "thumbnail_url": None,
        "nutrition_estimate": None,
        "bogus": "x",
    }
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=payload, schema=PHOTO_RECIPE_SCHEMA)


def test_photo_recipe_schema_accepts_nutrition_estimate_payload() -> None:
    """The photo schema inherits the optional nutrition_estimate object
    from the URL-path schema — handwritten recipes can also come with an
    LLM-guessed per-portion estimate."""
    payload: dict[str, Any] = {
        "title": "Omas Kuchen",
        "description": None,
        "servings": None,
        "difficulty": None,
        "prep_minutes": None,
        "cook_minutes": None,
        "components": [_photo_default_component()],
        "tags": [],
        "source_url": "photos://upload",
        "thumbnail_url": None,
        "nutrition_estimate": {
            "kcal": 380,
            "protein_g": 6,
            "carbs_g": 52,
            "fat_g": 14,
        },
    }
    jsonschema.validate(instance=payload, schema=PHOTO_RECIPE_SCHEMA)


def test_photo_system_prompt_de_requests_nutrition_estimation() -> None:
    """Photo pipeline's prompt also names the nutrition contract so the
    vision model fills the field for handwritten + printed recipes."""
    lowered = SYSTEM_PROMPT_DE.lower()
    assert "nährwert" in lowered or "kalorien" in lowered or "kcal" in lowered
    assert "portion" in lowered or "pro portion" in lowered


# ─────────────────────────────────────────────────────────────────────
# BUG-028 prompt-regression gates — quantity routing rule (mirror of
# the URL-prompt assertions in test_recipe_prompts.py).
# ─────────────────────────────────────────────────────────────────────


def test_system_prompt_forbids_mass_in_description() -> None:
    """Same hardening paragraph as the URL-path prompt: `description`,
    `quantity` and the hard-NO marker `NIEMALS` must appear within a
    400-char window of each other (tightest co-occurrence across all
    repeated mentions)."""
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
    """BUG-022 paragraph: `description` is named a Zusammenfassung /
    knapp summary within 200 chars of the field name."""
    text = SYSTEM_PROMPT_DE
    desc_idx = text.find("description")
    assert desc_idx >= 0, "prompt missing the word 'description'"
    window = text[max(0, desc_idx - 200) : desc_idx + 200].lower()
    assert "zusammenfassung" in window or "knapp" in window, (
        "the BUG-022 paragraph must describe `description` as a "
        "Zusammenfassung / knapp summary near the field name"
    )


# ─────────────────────────────────────────────────────────────────────
# BUG-030 — imperial → metric / German prompt directive (mirror of the
# URL-prompt assertion in test_recipe_prompts.py).
# ─────────────────────────────────────────────────────────────────────


def test_system_prompt_includes_imperial_to_metric_conversion() -> None:
    """BUG-030: the photo prompt must also name the metric-only rule AND
    list the imperial tokens alongside their German targets. Same
    paragraph verbatim as the URL-prompt — see
    ``test_recipe_prompts.test_system_prompt_includes_imperial_to_metric_conversion``
    for the rationale."""
    assert "metrisch" in SYSTEM_PROMPT_DE
    for token in ("oz", "cup", "tbsp", "tsp", "clove", "Zehe"):
        assert token in SYSTEM_PROMPT_DE, f"prompt missing token {token!r}"


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
        "components": [
            {
                "label": None,
                "position": 0,
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
            }
        ],
        "tags": [],
        "source_url": "https://example.com/x",
        "thumbnail_url": None,
        "nutrition_estimate": None,
    }
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=payload, schema=RECIPE_SCHEMA)
