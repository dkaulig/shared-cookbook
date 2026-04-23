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


def _default_component(
    *,
    label: str | None = None,
    position: int = 0,
    ingredients: list[dict[str, Any]] | None = None,
    steps: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Helper — builds a valid component object for fixture payloads."""
    return {
        "label": label,
        "position": position,
        "ingredients": ingredients if ingredients is not None else [],
        "steps": steps if steps is not None else [],
    }


def test_recipe_schema_accepts_minimal_valid_payload() -> None:
    """A payload with just the required fields + one default component validates."""
    payload: dict[str, Any] = {
        "title": "Einfaches Rezept",
        "description": None,
        "servings": None,
        "difficulty": None,
        "prep_minutes": None,
        "cook_minutes": None,
        "components": [_default_component()],
        "tags": [],
        "source_url": "https://example.com/rezept",
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
        "components": [_default_component()],
        "tags": [],
        "source_url": "https://example.com/rezept",
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
        "components": [_default_component()],
        "tags": [],
        "source_url": "https://example.com/rezept",
        "nutrition_estimate": None,
        "bogus_field": "should not be here",
    }
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=payload, schema=RECIPE_SCHEMA)


def test_recipe_schema_validates_full_payload() -> None:
    """Fully populated payload validates — components carry the
    ingredient + step arrays that used to be top-level."""
    payload = {
        "title": "Kaiserschmarrn",
        "description": "Österreichischer Klassiker.",
        "servings": 4,
        "difficulty": 2,
        "prep_minutes": 10,
        "cook_minutes": 15,
        "components": [
            _default_component(
                ingredients=[
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
                steps=[
                    {"position": 1, "content": "Teig anrühren.", "confidence": "high"},
                    {"position": 2, "content": "In der Pfanne braten.", "confidence": "medium"},
                ],
            )
        ],
        "tags": ["dessert", "süß", "klassiker"],
        "source_url": "https://example.com/kaiserschmarrn",
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
        "components": [
            _default_component(
                steps=[{"position": 1, "content": "do stuff", "confidence": "bogus"}],
            )
        ],
        "tags": [],
        "source_url": "https://example.com/x",
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
        "components": [
            _default_component(
                ingredients=[
                    {
                        "quantity": "1",
                        "unit": "Stk",
                        "note": None,
                        "confidence": "high",
                    }
                ],
            )
        ],
        "tags": [],
        "source_url": "https://example.com/x",
        "nutrition_estimate": None,
    }
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=payload, schema=RECIPE_SCHEMA)


# ─────────────────────────────────────────────────────────────────────
# COMP-1 — nested components schema
# ─────────────────────────────────────────────────────────────────────


def test_recipe_schema_rejects_legacy_flat_ingredients() -> None:
    """COMP-1 — the pre-components flat ``ingredients`` / ``steps`` shape
    is gone. A payload with top-level ``ingredients`` fails validation
    via ``additionalProperties: false`` so the migration is enforced at
    the schema boundary, not left to runtime parsing errors.
    """
    payload: dict[str, Any] = {
        "title": "Einfaches Rezept",
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
            }
        ],
        "steps": [],
        "tags": [],
        "source_url": "https://example.com/rezept",
        "nutrition_estimate": None,
    }
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=payload, schema=RECIPE_SCHEMA)


def test_recipe_schema_rejects_zero_components() -> None:
    """COMP-1 — at least one component is required (``minItems: 1``).

    The LLM may emit zero; the post-processor substitutes a default in
    that case. The schema still bounds the direct LLM output to the
    happy shape so a drifted prompt is caught at the structured-output
    boundary.
    """
    payload: dict[str, Any] = {
        "title": "X",
        "description": None,
        "servings": None,
        "difficulty": None,
        "prep_minutes": None,
        "cook_minutes": None,
        "components": [],
        "tags": [],
        "source_url": "https://example.com/x",
        "nutrition_estimate": None,
    }
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=payload, schema=RECIPE_SCHEMA)


def test_recipe_schema_accepts_two_labelled_components() -> None:
    """COMP-1 — multi-part recipes: two labelled components each with
    their own ingredients + steps. Quesadilla + Chipotle Sauce."""
    payload: dict[str, Any] = {
        "title": "Honey Chipotle Quesadilla",
        "description": None,
        "servings": None,
        "difficulty": None,
        "prep_minutes": None,
        "cook_minutes": None,
        "components": [
            _default_component(
                label="Chipotle Sauce",
                position=0,
                ingredients=[
                    {
                        "name": "Chipotle",
                        "quantity": "2",
                        "unit": "EL",
                        "note": None,
                        "confidence": "high",
                    }
                ],
                steps=[
                    {
                        "position": 1,
                        "content": "Chipotle verrühren.",
                        "confidence": "high",
                    }
                ],
            ),
            _default_component(
                label="Quesadilla",
                position=1,
                ingredients=[
                    {
                        "name": "Tortilla",
                        "quantity": "2",
                        "unit": "Stück",
                        "note": None,
                        "confidence": "high",
                    }
                ],
                steps=[
                    {
                        "position": 1,
                        "content": "Tortillas in der Pfanne anbraten.",
                        "confidence": "high",
                    }
                ],
            ),
        ],
        "tags": [],
        "source_url": "https://example.com/q",
        "nutrition_estimate": None,
    }
    jsonschema.validate(instance=payload, schema=RECIPE_SCHEMA)


def test_recipe_schema_accepts_null_component_label() -> None:
    """COMP-1 — the default single-component recipe has ``label=None``
    and must validate. This is the happy path for simple recipes that
    get one synthesised default component by the post-processor."""
    payload: dict[str, Any] = {
        "title": "Simple",
        "description": None,
        "servings": None,
        "difficulty": None,
        "prep_minutes": None,
        "cook_minutes": None,
        "components": [
            _default_component(label=None, position=0),
        ],
        "tags": [],
        "source_url": "https://example.com/x",
        "nutrition_estimate": None,
    }
    jsonschema.validate(instance=payload, schema=RECIPE_SCHEMA)


def test_recipe_schema_rejects_component_missing_position() -> None:
    """Every component must carry ``position`` — the schema enforces it
    so a drifted LLM emitting unordered components is caught at the
    boundary."""
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
                # position missing
                "ingredients": [],
                "steps": [],
            }
        ],
        "tags": [],
        "source_url": "https://example.com/x",
        "nutrition_estimate": None,
    }
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=payload, schema=RECIPE_SCHEMA)


def test_recipe_schema_rejects_component_with_extra_property() -> None:
    """``additionalProperties: false`` at the component level blocks drift.

    A future field (colour chip, icon) must be added explicitly to the
    schema; an un-declared key on the component fails validation.
    """
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
                "ingredients": [],
                "steps": [],
                "bogus": "nope",
            }
        ],
        "tags": [],
        "source_url": "https://example.com/x",
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


def test_build_user_message_orders_caption_before_transcript() -> None:
    """COMP-2 — a narrative Whisper transcript (no block separators)
    was observed to flatten the LLM's component-split output when
    placed ahead of the structured caption. Reorder caption-first so
    the formal block markers (``⸻`` / sub-headers) are the first
    structural signal the model encounters."""
    message = build_user_message(
        transcript="Hey guys today we make butter chicken",
        caption="Ingredients\n⸻\nSauce\nbutter\n⸻\nSpices\ngaram masala",
        blog_text=None,
        thumbnail_url=None,
    )
    caption_idx = message.index("Ingredients")
    transcript_idx = message.index("butter chicken")
    assert caption_idx < transcript_idx, (
        "Caption must appear before Transcript so structural signals dominate component detection."
    )


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
        "components": [_default_component()],
        "tags": [],
        "source_url": "https://example.com/x",
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
        "components": [_default_component()],
        "tags": [],
        "source_url": "https://example.com/x",
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
        "components": [_default_component()],
        "tags": [],
        "source_url": "https://example.com/x",
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
        "components": [_default_component()],
        "tags": [],
        "source_url": "https://example.com/x",
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
        "components": [_default_component()],
        "tags": [],
        "source_url": "https://example.com/x",
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


# ─────────────────────────────────────────────────────────────────────
# COMP-1 — component grouping directive
# ─────────────────────────────────────────────────────────────────────


def test_system_prompt_teaches_component_grouping() -> None:
    """COMP-1: the system prompt must instruct the LLM to split multi-
    part sources into ``components`` with a ``label`` per sub-recipe,
    and to fall back to a single ``label: null`` component when the
    source has only one recipe block. This is the mechanical hook the
    LLM uses to detect "Ingredients (Sauce):" headers in FB-reel
    captions. Pinned as a regression guard so a future edit that drops
    the paragraph surfaces in CI.
    """
    assert "components" in SYSTEM_PROMPT_DE, (
        "the prompt must name the `components` field so the LLM emits the nested shape"
    )
    # The key concept: a German term for "label" (name/Überschrift) and
    # the directive to fall back to a single null-labeled default.
    lowered = SYSTEM_PROMPT_DE.lower()
    assert "label" in lowered
    # Fallback directive: the single-default component for simple recipes.
    assert (
        "label: null" in SYSTEM_PROMPT_DE
        or "label=null" in SYSTEM_PROMPT_DE
        or '"label": null' in SYSTEM_PROMPT_DE
    )


# ─────────────────────────────────────────────────────────────────────
# COMP-FIX — hardened component-grouping directives
# ─────────────────────────────────────────────────────────────────────


def test_system_prompt_has_hard_component_split_rule() -> None:
    """COMP-FIX: when the LLM sees ≥ 2 distinct ingredient-blocks in the
    caption/transcript, it MUST emit ≥ 2 components. The soft
    ``Falls die Quelle …`` wording from COMP-1 was too permissive — the
    model would ignore visible separators (emojis, "For the X:" headers)
    and lump everything into one component. The hardened rule uses
    ``MUSST`` so the directive cannot be interpreted as optional.
    """
    # Mandatory-action keyword must appear somewhere tied to components.
    assert "MUSST" in SYSTEM_PROMPT_DE, (
        "COMP-FIX: prompt must include a HARD rule (MUSST) for "
        "component splitting — the soft ``Falls ...`` wording leaves "
        "splitting up to the LLM's mood"
    )
    # At least one of the English-header markers that FB reels commonly
    # use must appear as a concrete trigger the LLM can recognise.
    header_markers = ("For the", "Ingredients (", "ingredients:")
    assert any(marker in SYSTEM_PROMPT_DE for marker in header_markers), (
        "COMP-FIX: prompt must list concrete block-separator markers "
        "(e.g. 'For the X:' / 'Ingredients (Y):') so the LLM recognises "
        "the split signal in English captions"
    )


def test_system_prompt_forbids_generic_placeholder_labels() -> None:
    """COMP-FIX: single-component recipes must carry ``label: null`` —
    never a generic placeholder like "Hauptzutaten" or "Ingredients".
    The production bug we're fixing: the LLM emitted 1 component with
    ``label="Hauptzutaten"`` and the frontend rendered the dead-end
    header. The prompt now enumerates the forbidden strings explicitly.
    """
    # The hard-NO marker for the label rule.
    assert "NIE" in SYSTEM_PROMPT_DE or "NIEMALS" in SYSTEM_PROMPT_DE
    # At minimum the two repeat-offender strings must appear as
    # negative examples somewhere in the prompt.
    forbidden_labels = ("Hauptzutaten", "Hauptgericht")
    for label in forbidden_labels:
        assert label in SYSTEM_PROMPT_DE, (
            f"COMP-FIX: prompt must list {label!r} as a forbidden "
            f"placeholder label so the LLM doesn't emit it"
        )


def test_system_prompt_shows_concrete_split_example() -> None:
    """COMP-FIX: prompt carries a concrete mini-example demonstrating
    the Quesadilla-style split. Few-shot anchoring fights stochasticity
    better than pure rules. The example must be compact (not a full
    fixture dump) but must show at least two labelled blocks."""
    # Example anchor — we check for the archetypal Quesadilla-style
    # split labels the prompt references. Either the Honey Chipotle
    # sauce or the "Sauce" / "Teig" / similar concrete label.
    example_anchors = ("Honey Chipotle", "Chipotle Sauce", "Teig", "Füllung")
    hits = sum(1 for anchor in example_anchors if anchor in SYSTEM_PROMPT_DE)
    assert hits >= 2, (
        "COMP-FIX: prompt must carry a concrete multi-component mini-"
        "example (at least 2 distinct sub-recipe labels) to anchor the "
        "LLM's splitting behaviour — found "
        f"{hits} of: {example_anchors}"
    )
