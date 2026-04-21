"""Tests for the pipeline's post-processing rules.

Post-processing runs after the LLM returns a structured response. It's
defensive — keeps us honest even if the LLM mis-behaves:

- Clamp ``servings`` to 1..20.
- Flag ingredients without a quantity as ``confidence="missing"``.
- De-dupe tags + lowercase them.
- Preserve the caller's ``source_url`` verbatim (never let the LLM rewrite it).
- Keep the LLM-supplied ``thumbnail_url`` (or fall back to caller-supplied).
"""

from __future__ import annotations

from typing import Any

import pytest

from extractor.pipeline.post_process import (
    _normalise_ingredient,
    _translate_unit,
    post_process,
)


def _base_recipe_dict() -> dict[str, object]:
    """Minimal LLM response dict — one default component carrying one
    ingredient, one step, one tag. COMP-1 nested shape."""
    return {
        "title": "Apfelmus",
        "description": None,
        "servings": 4,
        "difficulty": None,
        "prep_minutes": None,
        "cook_minutes": None,
        "components": [
            {
                "label": None,
                "position": 0,
                "ingredients": [
                    {
                        "name": "Äpfel",
                        "quantity": "1",
                        "unit": "kg",
                        "note": None,
                        "confidence": "high",
                    }
                ],
                "steps": [
                    {"position": 1, "content": "Äpfel schälen.", "confidence": "high"},
                ],
            }
        ],
        "tags": ["Dessert"],
        "source_url": "https://llm-rewrote-url.example.com",
        "thumbnail_url": None,
    }


def _set_ingredients(data: dict[str, Any], ingredients: list[Any]) -> None:
    """Helper: overwrite the default component's ingredient list.

    COMP-1 moved ingredients under ``components[0]`` — this keeps the
    existing tests terse: they still want to express "the LLM emitted
    these ingredients", not thread through the nested component shape.
    """
    components = data["components"]
    assert isinstance(components, list) and components, "default component missing"
    components[0]["ingredients"] = ingredients


def _set_steps(data: dict[str, Any], steps: list[Any]) -> None:
    """Helper: overwrite the default component's step list."""
    components = data["components"]
    assert isinstance(components, list) and components, "default component missing"
    components[0]["steps"] = steps


def _result_ingredients(result: Any) -> list[Any]:
    """Helper: flatten the post-processed recipe's ingredients across
    its (normalised) components. Tests that assert on the first
    ingredient keep the same ergonomics as the pre-COMP-1 helper.
    """
    components = result["recipe"]["components"]
    out: list[Any] = []
    for c in components:
        out.extend(c["ingredients"])
    return out


def _result_steps(result: Any) -> list[Any]:
    """Helper: flatten the post-processed recipe's steps across
    components. Per-component ordering is preserved."""
    components = result["recipe"]["components"]
    out: list[Any] = []
    for c in components:
        out.extend(c["steps"])
    return out


def test_post_process_preserves_caller_source_url() -> None:
    """Even if the LLM rewrote ``source_url``, the caller's URL wins."""
    result = post_process(
        _base_recipe_dict(),
        original_url="https://example.com/apfelmus",
        fallback_thumbnail=None,
    )
    assert result["recipe"]["source_url"] == "https://example.com/apfelmus"


def test_post_process_clamps_servings_to_20() -> None:
    """servings=50 → clamped to 20."""
    data = _base_recipe_dict()
    data["servings"] = 50
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    assert result["recipe"]["servings"] == 20


def test_post_process_clamps_servings_to_1() -> None:
    """servings=0 → clamped to 1."""
    data = _base_recipe_dict()
    data["servings"] = 0
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    assert result["recipe"]["servings"] == 1


def test_post_process_leaves_valid_servings_alone() -> None:
    """servings=4 is in-range — unchanged."""
    result = post_process(
        _base_recipe_dict(),
        original_url="https://x",
        fallback_thumbnail=None,
    )
    assert result["recipe"]["servings"] == 4


def test_post_process_keeps_null_servings() -> None:
    """None stays None — no clamping of missing data."""
    data = _base_recipe_dict()
    data["servings"] = None
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    assert result["recipe"]["servings"] is None


def test_post_process_flags_missing_quantities() -> None:
    """Ingredient without ``quantity`` gets confidence='missing' even if
    the LLM claimed 'high'."""
    data = _base_recipe_dict()
    _set_ingredients(
        data,
        [
            {
                "name": "Salz",
                "quantity": None,
                "unit": None,
                "note": "nach Geschmack",
                "confidence": "high",
            }
        ],
    )
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    assert _result_ingredients(result)[0]["confidence"] == "missing"


def test_post_process_keeps_ingredient_confidence_when_quantity_present() -> None:
    """Ingredient WITH a quantity keeps its LLM confidence."""
    result = post_process(
        _base_recipe_dict(),
        original_url="https://x",
        fallback_thumbnail=None,
    )
    assert _result_ingredients(result)[0]["confidence"] == "high"


def test_post_process_lowercases_and_dedupes_tags() -> None:
    """Tags come out lowercase + deduplicated (first-occurrence order)."""
    data = _base_recipe_dict()
    data["tags"] = ["WARM", "warm", "Vegetarisch", "vegetarisch", "Abend"]
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    assert result["recipe"]["tags"] == ["warm", "vegetarisch", "abend"]


def test_post_process_strips_empty_tags() -> None:
    """Empty / whitespace-only tags drop out entirely."""
    data = _base_recipe_dict()
    data["tags"] = ["warm", "  ", ""]
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    assert result["recipe"]["tags"] == ["warm"]


def test_post_process_uses_fallback_thumbnail_when_llm_none() -> None:
    """When the LLM didn't supply a thumbnail, the caller's fallback wins."""
    result = post_process(
        _base_recipe_dict(),
        original_url="https://x",
        fallback_thumbnail="https://example.com/og.jpg",
    )
    assert result["recipe"]["thumbnail_url"] == "https://example.com/og.jpg"


def test_post_process_keeps_llm_thumbnail_when_present() -> None:
    """When the LLM picked a thumbnail, it wins over the fallback."""
    data = _base_recipe_dict()
    data["thumbnail_url"] = "https://example.com/llm-thumb.jpg"
    result = post_process(
        data,
        original_url="https://x",
        fallback_thumbnail="https://example.com/og.jpg",
    )
    assert result["recipe"]["thumbnail_url"] == "https://example.com/llm-thumb.jpg"


def test_post_process_starts_with_empty_notes_when_no_problems() -> None:
    """Happy path: notes list is empty."""
    result = post_process(
        _base_recipe_dict(),
        original_url="https://x",
        fallback_thumbnail=None,
    )
    assert result["confidence"]["notes"] == []


def test_post_process_forwards_extra_notes() -> None:
    """Caller-supplied extra notes (e.g. 'Website nicht erreichbar') are kept."""
    result = post_process(
        _base_recipe_dict(),
        original_url="https://x",
        fallback_thumbnail=None,
        extra_notes=["Website nicht erreichbar"],
    )
    assert "Website nicht erreichbar" in result["confidence"]["notes"]


def test_post_process_overall_confidence_low_when_most_missing() -> None:
    """When >= half the ingredients lack quantities, overall drops to 'low'."""
    data = _base_recipe_dict()
    _set_ingredients(
        data,
        [
            {
                "name": "Salz",
                "quantity": None,
                "unit": None,
                "note": None,
                "confidence": "high",
            },
            {
                "name": "Pfeffer",
                "quantity": None,
                "unit": None,
                "note": None,
                "confidence": "high",
            },
            {
                "name": "Öl",
                "quantity": "2",
                "unit": "EL",
                "note": None,
                "confidence": "high",
            },
        ],
    )
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    assert result["confidence"]["overall"] == "low"


def test_post_process_overall_confidence_high_when_clean() -> None:
    """All quantities present + all steps 'high' → overall='high'."""
    result = post_process(
        _base_recipe_dict(),
        original_url="https://x",
        fallback_thumbnail=None,
    )
    assert result["confidence"]["overall"] == "high"


# ─────────────────────────────────────────────────────────────────────
# Nutrition estimate (P2-10)
# ─────────────────────────────────────────────────────────────────────


def test_post_process_preserves_valid_nutrition_estimate() -> None:
    """An in-range nutrition_estimate flows through verbatim."""
    data = _base_recipe_dict()
    data["nutrition_estimate"] = {
        "kcal": 420,
        "protein_g": 24,
        "carbs_g": 38,
        "fat_g": 9,
    }
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    assert result["recipe"]["nutrition_estimate"] == {
        "kcal": 420,
        "protein_g": 24,
        "carbs_g": 38,
        "fat_g": 9,
    }


def test_post_process_null_nutrition_estimate_stays_null() -> None:
    """Absent / null nutrition stays null — no coercion to zero."""
    data = _base_recipe_dict()
    data["nutrition_estimate"] = None
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    assert result["recipe"]["nutrition_estimate"] is None


def test_post_process_missing_nutrition_estimate_stays_null() -> None:
    """Payload without the key → the field becomes ``None`` on the result."""
    data = _base_recipe_dict()
    assert "nutrition_estimate" not in data
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    assert result["recipe"]["nutrition_estimate"] is None


def test_post_process_clamps_nutrition_kcal_upper() -> None:
    """kcal > 5000 per portion → clamped to 5000 (LLM hallucination bound)."""
    data = _base_recipe_dict()
    data["nutrition_estimate"] = {
        "kcal": 99999,
        "protein_g": 10,
        "carbs_g": 10,
        "fat_g": 10,
    }
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    nutrition = result["recipe"]["nutrition_estimate"]
    assert nutrition is not None
    assert nutrition["kcal"] == 5000


def test_post_process_clamps_nutrition_kcal_negative() -> None:
    """Negative kcal → clamped to 0."""
    data = _base_recipe_dict()
    data["nutrition_estimate"] = {
        "kcal": -50,
        "protein_g": 10,
        "carbs_g": 10,
        "fat_g": 10,
    }
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    nutrition = result["recipe"]["nutrition_estimate"]
    assert nutrition is not None
    assert nutrition["kcal"] == 0


def test_post_process_clamps_nutrition_macros_upper() -> None:
    """Macros > 500 g per portion → clamped to 500."""
    data = _base_recipe_dict()
    data["nutrition_estimate"] = {
        "kcal": 400,
        "protein_g": 9999,
        "carbs_g": 9999,
        "fat_g": 9999,
    }
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    nutrition = result["recipe"]["nutrition_estimate"]
    assert nutrition is not None
    assert nutrition["protein_g"] == 500
    assert nutrition["carbs_g"] == 500
    assert nutrition["fat_g"] == 500


def test_post_process_clamps_nutrition_macros_negative() -> None:
    """Negative macros → clamped to 0."""
    data = _base_recipe_dict()
    data["nutrition_estimate"] = {
        "kcal": 400,
        "protein_g": -5,
        "carbs_g": -5,
        "fat_g": -5,
    }
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    nutrition = result["recipe"]["nutrition_estimate"]
    assert nutrition is not None
    assert nutrition["protein_g"] == 0
    assert nutrition["carbs_g"] == 0
    assert nutrition["fat_g"] == 0


def test_post_process_drops_malformed_nutrition_estimate() -> None:
    """Non-dict / non-numeric garbage is dropped entirely (becomes None)."""
    data = _base_recipe_dict()
    data["nutrition_estimate"] = "not a dict"
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    assert result["recipe"]["nutrition_estimate"] is None


def test_post_process_drops_nutrition_with_non_integer_field() -> None:
    """A string where an int is expected → drop the whole field."""
    data = _base_recipe_dict()
    data["nutrition_estimate"] = {
        "kcal": "viele",
        "protein_g": 10,
        "carbs_g": 10,
        "fat_g": 10,
    }
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    assert result["recipe"]["nutrition_estimate"] is None


def test_post_process_drops_nutrition_with_missing_field() -> None:
    """Missing required field inside the object → drop entirely."""
    data = _base_recipe_dict()
    data["nutrition_estimate"] = {
        "kcal": 300,
        "protein_g": 10,
        "carbs_g": 10,
        # fat_g missing
    }
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    assert result["recipe"]["nutrition_estimate"] is None


# ─────────────────────────────────────────────────────────────────────
# BUG-022 — description / steps[0] dedupe
# ─────────────────────────────────────────────────────────────────────


def test_bug022_drops_description_when_identical_to_first_step() -> None:
    """description == steps[0].content (verbatim) → description set to None.

    The Vision-LLM on handwritten photos likes to fill the required
    `description` field with the first step text. Post-process catches
    that with a SequenceMatcher ratio >= 0.80; an exact match is the
    trivial case.
    """
    data = _base_recipe_dict()
    data["description"] = "Zwiebel hacken und in Butter glasig dünsten"
    _set_steps(
        data,
        [
            {
                "position": 1,
                "content": "Zwiebel hacken und in Butter glasig dünsten",
                "confidence": "high",
            }
        ],
    )
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    assert result["recipe"]["description"] is None


def test_bug022_keeps_description_when_unrelated_to_steps() -> None:
    """A genuine summary description survives — no false-positive dedupe."""
    data = _base_recipe_dict()
    data["description"] = "Klassischer Apfelkuchen nach Oma-Rezept"
    _set_steps(
        data,
        [{"position": 1, "content": "Äpfel schälen", "confidence": "high"}],
    )
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    assert result["recipe"]["description"] == "Klassischer Apfelkuchen nach Oma-Rezept"


def test_bug022_borderline_similarity_threshold() -> None:
    """Borderline case: short description that is a strict prefix of the
    first step gets dropped via the substring short-circuit (description ⊂
    step). This is the side we came down on — a 4-word description that
    re-appears verbatim inside a 9-word first step is still "the LLM
    parroted the step into description". If the user wanted that exact
    summary they'd phrase it differently from the step instruction."""
    data = _base_recipe_dict()
    data["description"] = "Zwiebel fein hacken"
    _set_steps(
        data,
        [
            {
                "position": 1,
                "content": "Zwiebel fein hacken und in Butter dünsten",
                "confidence": "high",
            }
        ],
    )
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    assert result["recipe"]["description"] is None


# ─────────────────────────────────────────────────────────────────────
# BUG-028 — mass-leak in description downgrades ingredient confidence
# ─────────────────────────────────────────────────────────────────────


def test_bug028_downgrades_confidence_when_mass_in_description() -> None:
    """description carries a mass/volume token + ingredient has null qty
    → that ingredient's confidence is downgraded to "low" (the schema-
    valid stand-in for the prompt's "uncertain" instruction; the
    type-system enum doesn't include "uncertain")."""
    data = _base_recipe_dict()
    data["description"] = "ca. 500 g Fleisch dazugeben"
    _set_ingredients(
        data,
        [
            {
                "name": "Fleisch",
                "quantity": None,
                "unit": None,
                "note": None,
                "confidence": "high",
            }
        ],
    )
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    assert _result_ingredients(result)[0]["confidence"] == "low"


def test_bug028_does_not_downgrade_when_description_clean() -> None:
    """A description with no mass/volume token leaves ingredient confidence
    untouched — the guard is a precision filter, not a blanket downgrade."""
    data = _base_recipe_dict()
    data["description"] = "Klassischer Auflauf mit knuspriger Kruste"
    # The base dict already has a single ingredient with quantity="1 kg"
    # confidence="high"; that's the happy-path baseline.
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    assert _result_ingredients(result)[0]["confidence"] == "high"


def test_bug028_skips_guard_when_description_was_deduped() -> None:
    """If the description happens to mass-match a step (BUG-022 fires
    first → description becomes None), the BUG-028 guard sees no
    description and does not downgrade anything. Otherwise we'd flag
    ingredients based on text the user never sees."""
    data = _base_recipe_dict()
    # Step text contains a mass token; description is verbatim copy →
    # BUG-022 dedupe drops description before the BUG-028 guard runs.
    duplicated = "500 g Mehl in die Schüssel geben und verrühren"
    data["description"] = duplicated
    _set_steps(
        data,
        [{"position": 1, "content": duplicated, "confidence": "high"}],
    )
    _set_ingredients(
        data,
        [
            {
                "name": "Mehl",
                "quantity": None,
                "unit": None,
                "note": None,
                "confidence": "high",
            }
        ],
    )
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    assert result["recipe"]["description"] is None
    # Ingredient gets the standard `_normalise_ingredient` treatment
    # (null quantity → "missing"), NOT the BUG-028 downgrade to "low".
    assert _result_ingredients(result)[0]["confidence"] == "missing"


# ─────────────────────────────────────────────────────────────────────
# BUG-030 — imperial / English units → metric / German
# ─────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("unit_in", "qty_in", "expected_unit", "expected_qty"),
    [
        # Mass
        ("oz", "16", "g", "454"),  # 16 oz * 28.35 ≈ 453.6 → 454
        ("lb", "2", "g", "907"),
        ("OZ", "4", "g", "113"),  # case-insensitive
        ("  oz ", "1", "g", "28"),  # trimmed
        # Volume
        ("cup", "2", "ml", "480"),
        ("tbsp", "3", "ml", "45"),
        ("tsp", "1", "ml", "5"),
        ("fl oz", "1", "ml", "30"),
        # Count-like — factor 1, only label changes
        ("cloves", "4", "Zehe", "4"),
        ("stick", "1", "g", "113"),
        ("pinch", "1", "Prise", "1"),
        ("slice", "2", "Scheibe", "2"),
        # Pass-through on already-German units
        ("g", "500", "g", "500"),
        ("EL", "2", "EL", "2"),
        # Non-numeric quantity — only the unit translates, quantity verbatim
        ("oz", "1/2", "g", "1/2"),  # fraction passes through
        ("cup", "nach Geschmack", "ml", "nach Geschmack"),
        # Unknown unit — full pass-through
        ("blurbs", "7", "blurbs", "7"),
    ],
)
def test_translate_unit_cases(
    unit_in: str, qty_in: str, expected_unit: str, expected_qty: str
) -> None:
    """Theory-style sweep of the imperial → metric translation table.

    Covers the three input families:
    - numeric quantity + imperial unit → scaled metric quantity
    - non-numeric quantity + imperial unit → label-only translation
    - already-German or unknown unit → full pass-through
    """
    unit, qty, _ = _translate_unit(unit_in, qty_in)
    assert unit == expected_unit
    assert qty == expected_qty


def test_translate_unit_none_inputs_pass_through() -> None:
    """Defensive: ``unit=None`` is a valid ExtractedIngredient shape
    (quantity-less free-text ingredients like "Salz nach Geschmack")
    and must not crash the helper."""
    unit, qty, was = _translate_unit(None, "123")
    assert unit is None
    assert qty == "123"
    assert was is False


def test_translate_unit_none_quantity_on_imperial_unit() -> None:
    """Imperial unit with ``quantity=None`` — unit translates, quantity
    stays ``None``. Happens when the LLM found an ingredient line like
    'cloves garlic' without a count."""
    unit, qty, was = _translate_unit("cloves", None)
    assert unit == "Zehe"
    assert qty is None
    assert was is True


def test_translate_unit_decimal_comma_quantity() -> None:
    """German decimal comma ('1,5 oz') must round-trip correctly to the
    metric equivalent — both decimal separators are accepted."""
    unit, qty, _ = _translate_unit("oz", "1,5")
    assert unit == "g"
    assert qty == "43"  # 1.5 * 28.35 = 42.525 → rounds to 43


def test_normalise_ingredient_converts_imperial() -> None:
    """End-to-end: an imperial raw dict from Azure lands as metric/German
    on the normalised ingredient. Integration guard so a regression in
    either the table or the wiring shows up."""
    raw = {
        "name": "Hackfleisch",
        "quantity": "16",
        "unit": "oz",
        "note": "",
        "confidence": "high",
    }
    out = _normalise_ingredient(raw)
    assert out is not None
    assert out["quantity"] == "454"
    assert out["unit"] == "g"
    assert out["name"] == "Hackfleisch"
    # confidence + name + note pass-through still works.
    assert out["confidence"] == "high"


def test_normalise_ingredient_preserves_already_german() -> None:
    """A German-metric raw dict must round-trip unchanged — the BUG-030
    translation is strictly additive, never a corruption of good data."""
    raw = {
        "name": "Mehl",
        "quantity": "250",
        "unit": "g",
        "note": None,
        "confidence": "high",
    }
    out = _normalise_ingredient(raw)
    assert out is not None
    assert out["quantity"] == "250"
    assert out["unit"] == "g"


def test_post_process_imperial_ingredient_converted_end_to_end() -> None:
    """Integration through the full ``post_process`` entry point — the
    headline BUG-030 user story: '16 oz Hackfleisch' from an American
    recipe blog lands as '454 g Hackfleisch' in the pipeline output."""
    data = _base_recipe_dict()
    _set_ingredients(
        data,
        [
            {
                "name": "Hackfleisch",
                "quantity": "16",
                "unit": "oz",
                "note": None,
                "confidence": "high",
            },
            {
                "name": "Knoblauch",
                "quantity": "4",
                "unit": "cloves",
                "note": None,
                "confidence": "high",
            },
        ],
    )
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    ingredients = _result_ingredients(result)
    assert ingredients[0]["quantity"] == "454"
    assert ingredients[0]["unit"] == "g"
    assert ingredients[1]["quantity"] == "4"
    assert ingredients[1]["unit"] == "Zehe"


# ─────────────────────────────────────────────────────────────────────
# BUG-034 — empty-extraction quality gate
# ─────────────────────────────────────────────────────────────────────


def test_post_process_sets_recipe_empty_when_no_ingredients_or_steps() -> None:
    """Both lists empty + at least one signal true → ``no_recipe_detected``.

    Azure occasionally returns an entirely empty extraction (the Whisper
    transcript was chatter / no recipe content) but the HTTP path stays
    200. The post-processor flags that so the frontend can render a
    dedicated "Kein Rezept erkannt" explainer instead of a silent empty
    form — see the `EmptyExtractionExplainer` wrapper in the web app.

    When at least one signal source was present (here: transcript) the
    reason is ``no_recipe_detected`` — the LLM had data and still
    couldn't extract a recipe.
    """
    data = _base_recipe_dict()
    _set_ingredients(data, [])
    _set_steps(data, [])
    result = post_process(
        data,
        original_url="https://x",
        fallback_thumbnail=None,
        signals={
            "had_caption_url": False,
            "had_blog_source": False,
            "had_transcript": True,
        },
    )
    assert result["recipe_empty"] is True
    assert result["empty_reason"] == "no_recipe_detected"


def test_post_process_leaves_recipe_empty_false_on_valid_recipe() -> None:
    """Non-empty ingredients + steps → gate is silent.

    The happy path keeps `recipe_empty=False` and `empty_reason=None` so
    the wire shape is symmetric (both fields always present) and the
    frontend only branches into the explainer when the gate actually
    fires.
    """
    data = _base_recipe_dict()
    _set_ingredients(
        data,
        [
            {
                "name": "Mehl",
                "quantity": "500",
                "unit": "g",
                "note": None,
                "confidence": "high",
            },
            {
                "name": "Zucker",
                "quantity": "100",
                "unit": "g",
                "note": None,
                "confidence": "high",
            },
            {
                "name": "Eier",
                "quantity": "3",
                "unit": "Stück",
                "note": None,
                "confidence": "high",
            },
        ],
    )
    _set_steps(
        data,
        [
            {"position": 1, "content": "Ofen vorheizen.", "confidence": "high"},
            {"position": 2, "content": "Zutaten mischen.", "confidence": "high"},
        ],
    )
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    assert result["recipe_empty"] is False
    assert result["empty_reason"] is None


def test_post_process_sets_recipe_empty_when_all_ingredients_dropped() -> None:
    """Ingredients with blank names are dropped by `_normalise_ingredient`;
    if that leaves zero ingredients AND steps is empty, the gate fires.

    Tests the post-normalise check (not pre-normalise) — the guard
    looks at the cleaned-up `ingredients`/`steps` lists so LLM noise
    (blank-name rows, malformed steps) doesn't accidentally keep the
    gate silent on an effectively-empty recipe.
    """
    data = _base_recipe_dict()
    _set_ingredients(
        data,
        [
            {
                "name": "",  # dropped by _normalise_ingredient
                "quantity": "1",
                "unit": "g",
                "note": None,
                "confidence": "high",
            },
            {
                "name": "   ",  # also dropped (whitespace-only)
                "quantity": "2",
                "unit": "g",
                "note": None,
                "confidence": "high",
            },
        ],
    )
    _set_steps(data, [])
    result = post_process(
        data,
        original_url="https://x",
        fallback_thumbnail=None,
        signals={
            "had_caption_url": False,
            "had_blog_source": False,
            "had_transcript": True,
        },
    )
    assert _result_ingredients(result) == []
    assert _result_steps(result) == []
    assert result["recipe_empty"] is True
    assert result["empty_reason"] == "no_recipe_detected"


# ─────────────────────────────────────────────────────────────────────
# BUG-034 — signals + no_usable_source empty_reason derivation
# ─────────────────────────────────────────────────────────────────────


def test_post_process_defaults_signals_to_all_false_when_not_supplied() -> None:
    """Legacy callers that don't pass ``signals`` still get a valid
    envelope — all three flags default to False. Keeps the wire contract
    symmetric and lets the .NET side persist ``ResultJson`` without
    special-casing an optional key."""
    data = _base_recipe_dict()
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    assert result["signals"] == {
        "had_caption_url": False,
        "had_blog_source": False,
        "had_transcript": False,
    }


def test_post_process_echoes_supplied_signals_on_healthy_recipe() -> None:
    """When the recipe is non-empty ``empty_reason`` stays None but
    ``signals`` still flow through — admins use them for observability
    on healthy imports too."""
    data = _base_recipe_dict()
    result = post_process(
        data,
        original_url="https://x",
        fallback_thumbnail=None,
        signals={
            "had_caption_url": True,
            "had_blog_source": False,
            "had_transcript": True,
        },
    )
    assert result["recipe_empty"] is False
    assert result["empty_reason"] is None
    assert result["signals"] == {
        "had_caption_url": True,
        "had_blog_source": False,
        "had_transcript": True,
    }


def test_post_process_empty_all_signals_false_yields_no_usable_source() -> None:
    """All three signal flags false + empty recipe → ``no_usable_source``.
    This is the FB-reel-with-no-caption-no-audio-no-blog case."""
    data = _base_recipe_dict()
    _set_ingredients(data, [])
    _set_steps(data, [])
    result = post_process(
        data,
        original_url="https://x",
        fallback_thumbnail=None,
        signals={
            "had_caption_url": False,
            "had_blog_source": False,
            "had_transcript": False,
        },
    )
    assert result["recipe_empty"] is True
    assert result["empty_reason"] == "no_usable_source"


def test_post_process_empty_with_transcript_yields_no_recipe_detected() -> None:
    """Any true signal + empty recipe → keep ``no_recipe_detected`` so
    the copy explains "the sources were there but Azure found no recipe"."""
    data = _base_recipe_dict()
    _set_ingredients(data, [])
    _set_steps(data, [])
    result = post_process(
        data,
        original_url="https://x",
        fallback_thumbnail=None,
        signals={
            "had_caption_url": False,
            "had_blog_source": False,
            "had_transcript": True,
        },
    )
    assert result["recipe_empty"] is True
    assert result["empty_reason"] == "no_recipe_detected"


def test_post_process_empty_with_blog_yields_no_recipe_detected() -> None:
    """Blog-only signal + empty recipe → ``no_recipe_detected``."""
    data = _base_recipe_dict()
    _set_ingredients(data, [])
    _set_steps(data, [])
    result = post_process(
        data,
        original_url="https://x",
        fallback_thumbnail=None,
        signals={
            "had_caption_url": False,
            "had_blog_source": True,
            "had_transcript": False,
        },
    )
    assert result["recipe_empty"] is True
    assert result["empty_reason"] == "no_recipe_detected"


def test_post_process_empty_with_caption_url_yields_no_recipe_detected() -> None:
    """Caption URL signal + empty recipe → ``no_recipe_detected``."""
    data = _base_recipe_dict()
    _set_ingredients(data, [])
    _set_steps(data, [])
    result = post_process(
        data,
        original_url="https://x",
        fallback_thumbnail=None,
        signals={
            "had_caption_url": True,
            "had_blog_source": False,
            "had_transcript": False,
        },
    )
    assert result["recipe_empty"] is True
    assert result["empty_reason"] == "no_recipe_detected"


# ─────────────────────────────────────────────────────────────────────
# COMP-1 — component normalisation
# ─────────────────────────────────────────────────────────────────────


def test_comp1_components_renumber_to_contiguous_positions() -> None:
    """COMP-1: LLM emits components with gaps/reordering; post-process
    renumbers to ``[0, 1, 2, ...]`` in LLM-emitted ``position`` order.

    Sort-by-position then renumber so the frontend can trust ``position``
    as a React key and an ordering index regardless of the LLM's output.
    """
    data = _base_recipe_dict()
    data["components"] = [
        {
            "label": "Zweite",
            "position": 5,
            "ingredients": [],
            "steps": [],
        },
        {
            "label": "Erste",
            "position": 2,
            "ingredients": [],
            "steps": [],
        },
        {
            "label": "Dritte",
            "position": 9,
            "ingredients": [],
            "steps": [],
        },
    ]
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    components = result["recipe"]["components"]
    # Sorted by LLM-emitted position (2 < 5 < 9) then renumbered 0..N.
    assert [c["label"] for c in components] == ["Erste", "Zweite", "Dritte"]
    assert [c["position"] for c in components] == [0, 1, 2]


def test_comp1_components_dedupe_duplicate_labels_keep_lowest_position() -> None:
    """COMP-1: LLM quirk — duplicate labels. Keep the entry with the
    lowest emitted position; drop the higher-position duplicate. This
    is the frequent "LLM emitted the same component twice because the
    caption repeated the header" pattern.
    """
    data = _base_recipe_dict()
    data["components"] = [
        {
            "label": "Sauce",
            "position": 2,
            "ingredients": [
                {
                    "name": "Second (dup)",
                    "quantity": "1",
                    "unit": "g",
                    "note": None,
                    "confidence": "high",
                }
            ],
            "steps": [],
        },
        {
            "label": "Sauce",
            "position": 0,
            "ingredients": [
                {
                    "name": "First (winner)",
                    "quantity": "2",
                    "unit": "g",
                    "note": None,
                    "confidence": "high",
                }
            ],
            "steps": [],
        },
    ]
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    components = result["recipe"]["components"]
    # Dedupe keeps the first-position entry (position=0) — its
    # ingredients survive, not the higher-position duplicate's.
    assert len(components) == 1
    assert components[0]["label"] == "Sauce"
    assert components[0]["position"] == 0
    names = [i["name"] for i in components[0]["ingredients"]]
    assert names == ["First (winner)"]


def test_comp1_components_dedupe_null_labels_are_independent() -> None:
    """Dedupe keys on the trimmed label string; ``label=None`` entries
    are NOT deduped because two unlabelled components represent two
    distinct sub-recipes the user (or LLM) intentionally separated.
    """
    data = _base_recipe_dict()
    data["components"] = [
        {
            "label": None,
            "position": 0,
            "ingredients": [],
            "steps": [],
        },
        {
            "label": None,
            "position": 1,
            "ingredients": [],
            "steps": [],
        },
    ]
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    components = result["recipe"]["components"]
    assert len(components) == 2
    assert [c["position"] for c in components] == [0, 1]


def test_comp1_missing_components_key_synthesises_default_single_component() -> None:
    """COMP-1 invariant: the response ALWAYS has at least one component.

    When the LLM's payload has no ``components`` key (or an empty list),
    post-process substitutes a single default ``{label: null, position: 0,
    ingredients: [], steps: []}`` so the .NET side's COMP-0 domain
    invariant (recipe has ≥ 1 RecipeComponent) is satisfied.
    """
    data = _base_recipe_dict()
    del data["components"]
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    components = result["recipe"]["components"]
    assert len(components) == 1
    assert components[0]["label"] is None
    assert components[0]["position"] == 0
    assert components[0]["ingredients"] == []
    assert components[0]["steps"] == []


def test_comp1_empty_components_list_synthesises_default() -> None:
    """COMP-1 invariant: same default-substitution when the LLM emits an
    explicit empty ``components`` array (schema should reject this, but
    the retry path can hand us a zero-component blob)."""
    data = _base_recipe_dict()
    data["components"] = []
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    components = result["recipe"]["components"]
    assert len(components) == 1
    assert components[0]["label"] is None
    assert components[0]["position"] == 0


def test_comp1_recipe_empty_fires_when_all_components_have_no_content() -> None:
    """COMP-1: ``recipe_empty`` fires when ALL components have 0
    ingredients AND 0 steps — i.e. the recipe has nothing consumable.
    Single-default case that matches pre-COMP-1 "both lists empty"
    behaviour.
    """
    data = _base_recipe_dict()
    _set_ingredients(data, [])
    _set_steps(data, [])
    result = post_process(
        data,
        original_url="https://x",
        fallback_thumbnail=None,
        signals={
            "had_caption_url": False,
            "had_blog_source": False,
            "had_transcript": True,
        },
    )
    assert result["recipe_empty"] is True
    assert result["empty_reason"] == "no_recipe_detected"


def test_comp1_recipe_empty_fires_when_multi_components_all_empty() -> None:
    """COMP-1: multi-component recipes where EVERY component is empty
    still fire the empty gate."""
    data = _base_recipe_dict()
    data["components"] = [
        {"label": "Erste", "position": 0, "ingredients": [], "steps": []},
        {"label": "Zweite", "position": 1, "ingredients": [], "steps": []},
    ]
    result = post_process(
        data,
        original_url="https://x",
        fallback_thumbnail=None,
        signals={
            "had_caption_url": False,
            "had_blog_source": False,
            "had_transcript": True,
        },
    )
    assert result["recipe_empty"] is True
    assert result["empty_reason"] == "no_recipe_detected"


def test_comp1_recipe_empty_false_when_any_component_has_content() -> None:
    """COMP-1: if at least one component carries ingredients OR steps,
    the recipe is not empty."""
    data = _base_recipe_dict()
    data["components"] = [
        {"label": "Leere", "position": 0, "ingredients": [], "steps": []},
        {
            "label": "Gefüllte",
            "position": 1,
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
        },
    ]
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    assert result["recipe_empty"] is False
    assert result["empty_reason"] is None


def test_comp1_default_single_component_passes_through_unchanged() -> None:
    """A single default component (label=None, position=0, real content)
    flows through post-process verbatim — no reorder, no dedupe, no
    default-substitution. Happy-path pre-COMP-1 parity."""
    data = _base_recipe_dict()
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    components = result["recipe"]["components"]
    assert len(components) == 1
    assert components[0]["label"] is None
    assert components[0]["position"] == 0
    assert len(components[0]["ingredients"]) == 1
    assert len(components[0]["steps"]) == 1


def test_comp1_step_positions_renumbered_per_component_independently() -> None:
    """Step ``position`` gets renumbered 1..N within each component, not
    across the whole recipe. Two components with out-of-order steps each
    get their own sequential sequence.
    """
    data = _base_recipe_dict()
    data["components"] = [
        {
            "label": "A",
            "position": 0,
            "ingredients": [],
            "steps": [
                {"position": 5, "content": "A-erster", "confidence": "high"},
                {"position": 2, "content": "A-zweiter", "confidence": "high"},
            ],
        },
        {
            "label": "B",
            "position": 1,
            "ingredients": [],
            "steps": [
                {"position": 9, "content": "B-erster", "confidence": "high"},
            ],
        },
    ]
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    components = result["recipe"]["components"]
    a_positions = [s["position"] for s in components[0]["steps"]]
    b_positions = [s["position"] for s in components[1]["steps"]]
    # Each component renumbers its own steps 1..N; input order preserved.
    assert a_positions == [1, 2]
    assert b_positions == [1]


def test_comp1_label_trimmed_and_length_capped() -> None:
    """Security: the component ``label`` renders on the detail page.
    Post-process trims whitespace and caps length at 50 chars (same as
    tag names) so a hostile LLM can't emit an HTML-looking free-form
    string that pokes at the frontend renderer. Longer labels are hard-
    truncated rather than dropped — losing the last few characters is
    better UX than losing the whole component."""
    data = _base_recipe_dict()
    long_label = "x" * 200
    data["components"] = [
        {
            "label": f"  {long_label}  ",
            "position": 0,
            "ingredients": [],
            "steps": [],
        }
    ]
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    components = result["recipe"]["components"]
    out_label = components[0]["label"]
    assert out_label is not None
    # Trimmed + capped at 50.
    assert len(out_label) == 50
    assert out_label == "x" * 50


def test_comp1_empty_label_string_coerced_to_null() -> None:
    """A whitespace-only label is dropped to ``None`` — the frontend
    suppresses component headers when label is null, so an empty string
    would render a blank header box. ``None`` is the explicit signal."""
    data = _base_recipe_dict()
    data["components"] = [
        {
            "label": "   ",
            "position": 0,
            "ingredients": [],
            "steps": [],
        }
    ]
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    components = result["recipe"]["components"]
    assert components[0]["label"] is None


# ─────────────────────────────────────────────────────────────────────
# COMP-FIX — generic-placeholder label safeguard
# ─────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "placeholder",
    [
        "Hauptzutaten",
        "Zutaten",
        "Hauptgericht",
        "Ingredients",
        "Main",
        "Main Ingredients",
        "Recipe",
        # Case-insensitive + trim invariants — same blacklist, uglier input.
        "HAUPTZUTATEN",
        "  Hauptzutaten  ",
        "ingredients",
        "main ingredients",
    ],
)
def test_compfix_single_component_generic_label_normalised_to_null(
    placeholder: str,
) -> None:
    """COMP-FIX defence-in-depth: when the LLM emits exactly 1 component
    whose label matches the generic-placeholder blacklist, post-process
    rewrites the label to ``None``.

    The UI convention is "1 component + null label = no component header".
    A placeholder like ``"Hauptzutaten"`` produces a dead-end header box
    that signals nothing. The hardened prompt should prevent these from
    being emitted, but if one slips through the safeguard preserves the
    UI contract.

    Blacklist is case-insensitive and trim-first so typo variants
    (``"  Hauptzutaten  "``, ``"INGREDIENTS"``) don't evade it.
    """
    data = _base_recipe_dict()
    data["components"] = [
        {
            "label": placeholder,
            "position": 0,
            "ingredients": [
                {
                    "name": "Mehl",
                    "quantity": "250",
                    "unit": "g",
                    "note": None,
                    "confidence": "high",
                }
            ],
            "steps": [
                {"position": 1, "content": "Schritt.", "confidence": "high"},
            ],
        }
    ]
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    components = result["recipe"]["components"]
    assert len(components) == 1
    assert components[0]["label"] is None, (
        f"COMP-FIX safeguard must normalise generic placeholder "
        f"{placeholder!r} to None on single-component recipes"
    )


def test_compfix_safeguard_does_not_fire_on_multi_component_recipes() -> None:
    """The safeguard is strictly scoped to the single-component case.

    If the LLM emits multiple components AND one of them happens to
    carry a blacklist label, leaving the labels alone is safer — a
    multi-component recipe with one block literally titled
    "Hauptzutaten" is a valid split that deserves to render its header.
    The rule only rewrites when exactly 1 component is present because
    THAT is the case where the label is a useless placeholder.
    """
    data = _base_recipe_dict()
    data["components"] = [
        {
            "label": "Hauptzutaten",
            "position": 0,
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
        },
        {
            "label": "Sauce",
            "position": 1,
            "ingredients": [
                {
                    "name": "Öl",
                    "quantity": "50",
                    "unit": "ml",
                    "note": None,
                    "confidence": "high",
                }
            ],
            "steps": [],
        },
    ]
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    components = result["recipe"]["components"]
    assert len(components) == 2
    # Labels survive verbatim — the rewrite is scoped to single-component recipes.
    assert components[0]["label"] == "Hauptzutaten"
    assert components[1]["label"] == "Sauce"


def test_compfix_safeguard_preserves_meaningful_single_component_labels() -> None:
    """A legitimately-named single component (e.g. "Hähnchen und Füllung")
    survives the safeguard unchanged — the blacklist is tight and does
    not match real recipe-block names.
    """
    data = _base_recipe_dict()
    data["components"] = [
        {
            "label": "Hähnchen und Füllung",
            "position": 0,
            "ingredients": [
                {
                    "name": "Hähnchenbrust",
                    "quantity": "500",
                    "unit": "g",
                    "note": None,
                    "confidence": "high",
                }
            ],
            "steps": [],
        },
    ]
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    components = result["recipe"]["components"]
    assert len(components) == 1
    assert components[0]["label"] == "Hähnchen und Füllung"


def test_post_process_renumbers_step_positions_to_sequential_1_to_n() -> None:
    """Plan §2.5 post-process: step positions must be 1..N in input order
    even when the LLM returns gapped (1, 3, 5) or mis-ordered values.
    Prevents the frontend from seeing "Schritt 3" with no "Schritt 2"
    above it, or duplicate positions that collide in keyed React lists."""
    payload = {
        "title": "Rezept",
        "servings": 2,
        "components": [
            {
                "label": None,
                "position": 0,
                "ingredients": [
                    {"name": "Mehl", "quantity": "250", "unit": "g", "confidence": "high"},
                ],
                "steps": [
                    {"position": 3, "content": "Dritter Schritt laut LLM.", "confidence": "high"},
                    {"position": 1, "content": "Erster Schritt laut LLM.", "confidence": "high"},
                    {"position": 7, "content": "Schritt mit Riesen-Sprung.", "confidence": "high"},
                ],
            }
        ],
        "tags": [],
    }
    result = post_process(payload, original_url="https://x", fallback_thumbnail=None)
    positions = [step["position"] for step in _result_steps(result)]
    # Order of iteration is preserved (input order); positions re-assigned 1..N.
    assert positions == [1, 2, 3]
    # Content pinned to input order too — a sort-by-position would break this.
    contents = [step["content"] for step in _result_steps(result)]
    assert contents == [
        "Dritter Schritt laut LLM.",
        "Erster Schritt laut LLM.",
        "Schritt mit Riesen-Sprung.",
    ]
