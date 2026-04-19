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

from extractor.pipeline.post_process import post_process


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
