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

import pytest

from extractor.pipeline.post_process import (
    _normalise_ingredient,
    _translate_unit,
    post_process,
)


def _base_recipe_dict() -> dict[str, object]:
    """Minimal LLM response dict — one ingredient, one step, one tag."""
    return {
        "title": "Apfelmus",
        "description": None,
        "servings": 4,
        "difficulty": None,
        "prep_minutes": None,
        "cook_minutes": None,
        "ingredients": [
            {
                "name": "Äpfel",
                "quantity": "1",
                "unit": "kg",
                "note": None,
                "confidence": "high",
            }
        ],
        "steps": [{"position": 1, "content": "Äpfel schälen.", "confidence": "high"}],
        "tags": ["Dessert"],
        "source_url": "https://llm-rewrote-url.example.com",
        "thumbnail_url": None,
    }


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
    data["ingredients"] = [
        {
            "name": "Salz",
            "quantity": None,
            "unit": None,
            "note": "nach Geschmack",
            "confidence": "high",
        }
    ]
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    assert result["recipe"]["ingredients"][0]["confidence"] == "missing"


def test_post_process_keeps_ingredient_confidence_when_quantity_present() -> None:
    """Ingredient WITH a quantity keeps its LLM confidence."""
    result = post_process(
        _base_recipe_dict(),
        original_url="https://x",
        fallback_thumbnail=None,
    )
    assert result["recipe"]["ingredients"][0]["confidence"] == "high"


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
    data["ingredients"] = [
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
    ]
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
    data["steps"] = [
        {
            "position": 1,
            "content": "Zwiebel hacken und in Butter glasig dünsten",
            "confidence": "high",
        }
    ]
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    assert result["recipe"]["description"] is None


def test_bug022_keeps_description_when_unrelated_to_steps() -> None:
    """A genuine summary description survives — no false-positive dedupe."""
    data = _base_recipe_dict()
    data["description"] = "Klassischer Apfelkuchen nach Oma-Rezept"
    data["steps"] = [
        {"position": 1, "content": "Äpfel schälen", "confidence": "high"},
    ]
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
    data["steps"] = [
        {
            "position": 1,
            "content": "Zwiebel fein hacken und in Butter dünsten",
            "confidence": "high",
        }
    ]
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
    data["ingredients"] = [
        {
            "name": "Fleisch",
            "quantity": None,
            "unit": None,
            "note": None,
            "confidence": "high",
        }
    ]
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    assert result["recipe"]["ingredients"][0]["confidence"] == "low"


def test_bug028_does_not_downgrade_when_description_clean() -> None:
    """A description with no mass/volume token leaves ingredient confidence
    untouched — the guard is a precision filter, not a blanket downgrade."""
    data = _base_recipe_dict()
    data["description"] = "Klassischer Auflauf mit knuspriger Kruste"
    # The base dict already has a single ingredient with quantity="1 kg"
    # confidence="high"; that's the happy-path baseline.
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    assert result["recipe"]["ingredients"][0]["confidence"] == "high"


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
    data["steps"] = [{"position": 1, "content": duplicated, "confidence": "high"}]
    data["ingredients"] = [
        {
            "name": "Mehl",
            "quantity": None,
            "unit": None,
            "note": None,
            "confidence": "high",
        }
    ]
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    assert result["recipe"]["description"] is None
    # Ingredient gets the standard `_normalise_ingredient` treatment
    # (null quantity → "missing"), NOT the BUG-028 downgrade to "low".
    assert result["recipe"]["ingredients"][0]["confidence"] == "missing"


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
    data["ingredients"] = [
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
    ]
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    ingredients = result["recipe"]["ingredients"]
    assert ingredients[0]["quantity"] == "454"
    assert ingredients[0]["unit"] == "g"
    assert ingredients[1]["quantity"] == "4"
    assert ingredients[1]["unit"] == "Zehe"


# ─────────────────────────────────────────────────────────────────────
# BUG-034 — empty-extraction quality gate
# ─────────────────────────────────────────────────────────────────────


def test_post_process_sets_recipe_empty_when_no_ingredients_or_steps() -> None:
    """Both lists empty on input → `recipe_empty=True`, reason set.

    Azure occasionally returns an entirely empty extraction (the Whisper
    transcript was chatter / no recipe content) but the HTTP path stays
    200. The post-processor flags that so the frontend can render a
    dedicated "Kein Rezept erkannt" explainer instead of a silent empty
    form — see the `EmptyExtractionExplainer` wrapper in the web app.
    """
    data = _base_recipe_dict()
    data["ingredients"] = []
    data["steps"] = []
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
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
    data["ingredients"] = [
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
    ]
    data["steps"] = [
        {"position": 1, "content": "Ofen vorheizen.", "confidence": "high"},
        {"position": 2, "content": "Zutaten mischen.", "confidence": "high"},
    ]
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
    data["ingredients"] = [
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
    ]
    data["steps"] = []
    result = post_process(data, original_url="https://x", fallback_thumbnail=None)
    assert result["recipe"]["ingredients"] == []
    assert result["recipe"]["steps"] == []
    assert result["recipe_empty"] is True
    assert result["empty_reason"] == "no_recipe_detected"


def test_post_process_renumbers_step_positions_to_sequential_1_to_n() -> None:
    """Plan §2.5 post-process: step positions must be 1..N in input order
    even when the LLM returns gapped (1, 3, 5) or mis-ordered values.
    Prevents the frontend from seeing "Schritt 3" with no "Schritt 2"
    above it, or duplicate positions that collide in keyed React lists."""
    payload = {
        "title": "Rezept",
        "servings": 2,
        "ingredients": [
            {"name": "Mehl", "quantity": "250", "unit": "g", "confidence": "high"},
        ],
        "steps": [
            {"position": 3, "content": "Dritter Schritt laut LLM.", "confidence": "high"},
            {"position": 1, "content": "Erster Schritt laut LLM.", "confidence": "high"},
            {"position": 7, "content": "Schritt mit Riesen-Sprung.", "confidence": "high"},
        ],
        "tags": [],
    }
    result = post_process(payload, original_url="https://x", fallback_thumbnail=None)
    positions = [step["position"] for step in result["recipe"]["steps"]]
    # Order of iteration is preserved (input order); positions re-assigned 1..N.
    assert positions == [1, 2, 3]
    # Content pinned to input order too — a sort-by-position would break this.
    contents = [step["content"] for step in result["recipe"]["steps"]]
    assert contents == [
        "Dritter Schritt laut LLM.",
        "Erster Schritt laut LLM.",
        "Schritt mit Riesen-Sprung.",
    ]
