"""Smoke tests for the pipeline TypedDict contract.

These tests pin the shape of ``ExtractionResult`` and its components —
the API boundary consumed by the .NET side (P2-6). Any drift here is a
breaking change and needs an explicit plan-doc update.
"""

from __future__ import annotations

from typing import get_args

from extractor.pipeline.types import (
    CONFIDENCE_LEVELS,
    INGREDIENT_CONFIDENCE_LEVELS,
    STEP_CONFIDENCE_LEVELS,
    ConfidenceLevel,
    ExtractedIngredient,
    ExtractedRecipe,
    ExtractedStep,
    ExtractionConfidence,
    ExtractionResult,
    IngredientConfidenceLevel,
    NutritionEstimate,
    StepConfidenceLevel,
)


def test_confidence_level_literal_contains_expected_values() -> None:
    """``high | medium | low`` — the three levels the overall badge uses."""
    assert set(get_args(ConfidenceLevel)) == {"high", "medium", "low"}


def test_ingredient_confidence_level_literal_adds_missing_and_handwritten() -> None:
    """Ingredients get ``missing`` (post-process flag) and
    ``handwritten_uncertain`` (photo path, P2-3) in addition to the
    three base levels."""
    assert set(get_args(IngredientConfidenceLevel)) == {
        "high",
        "medium",
        "low",
        "missing",
        "handwritten_uncertain",
    }


def test_step_confidence_level_literal_adds_handwritten_uncertain() -> None:
    """Steps can also be flagged ``handwritten_uncertain`` on the
    photo path — a barely-legible step still makes it into the
    response instead of being silently dropped."""
    assert set(get_args(StepConfidenceLevel)) == {
        "high",
        "medium",
        "low",
        "handwritten_uncertain",
    }


def test_confidence_levels_tuple_matches_literal() -> None:
    """Runtime-accessible tuple stays in sync with the literal."""
    assert set(CONFIDENCE_LEVELS) == set(get_args(ConfidenceLevel))


def test_ingredient_confidence_levels_tuple_matches_literal() -> None:
    """Runtime-accessible tuple stays in sync with the literal."""
    assert set(INGREDIENT_CONFIDENCE_LEVELS) == set(get_args(IngredientConfidenceLevel))


def test_step_confidence_levels_tuple_matches_literal() -> None:
    """Runtime-accessible tuple stays in sync with the literal."""
    assert set(STEP_CONFIDENCE_LEVELS) == set(get_args(StepConfidenceLevel))


def test_extracted_ingredient_shape() -> None:
    """Ingredient carries name + optional quantity/unit/note + confidence."""
    ingredient: ExtractedIngredient = {
        "name": "Mehl",
        "quantity": "250",
        "unit": "g",
        "note": None,
        "confidence": "high",
    }
    assert ingredient["name"] == "Mehl"
    assert ingredient["quantity"] == "250"
    assert ingredient["unit"] == "g"
    assert ingredient["note"] is None
    assert ingredient["confidence"] == "high"


def test_extracted_step_shape() -> None:
    """Step carries 1-indexed position + content + confidence."""
    step: ExtractedStep = {"position": 1, "content": "Mehl abwiegen.", "confidence": "high"}
    assert step["position"] == 1
    assert step["content"] == "Mehl abwiegen."
    assert step["confidence"] == "high"


def test_extracted_recipe_shape() -> None:
    """Recipe is the full structured payload matching the plan's response."""
    recipe: ExtractedRecipe = {
        "title": "Nudelauflauf",
        "description": "Schnell und cremig.",
        "servings": 4,
        "difficulty": 2,
        "prep_minutes": 10,
        "cook_minutes": 30,
        "ingredients": [
            {
                "name": "Nudeln",
                "quantity": "500",
                "unit": "g",
                "note": None,
                "confidence": "high",
            }
        ],
        "steps": [{"position": 1, "content": "Wasser aufsetzen.", "confidence": "high"}],
        "tags": ["warm", "familie"],
        "source_url": "https://example.com/nudeln",
        "thumbnail_url": "https://example.com/nudeln.jpg",
        "nutrition_estimate": None,
    }
    assert recipe["title"] == "Nudelauflauf"
    assert len(recipe["ingredients"]) == 1
    assert len(recipe["steps"]) == 1


def test_extraction_result_shape() -> None:
    """Result wraps recipe + per-request confidence metadata + notes."""
    result: ExtractionResult = {
        "recipe": {
            "title": "Kaiserschmarrn",
            "description": None,
            "servings": 2,
            "difficulty": None,
            "prep_minutes": None,
            "cook_minutes": None,
            "ingredients": [],
            "steps": [],
            "tags": [],
            "source_url": "https://example.com/kaiserschmarrn",
            "thumbnail_url": None,
            "nutrition_estimate": None,
        },
        "confidence": {"overall": "medium", "notes": ["Keine Mengen erkannt"]},
        "recipe_empty": False,
        "empty_reason": None,
    }
    assert result["recipe"]["title"] == "Kaiserschmarrn"
    assert result["confidence"]["overall"] == "medium"
    assert result["confidence"]["notes"] == ["Keine Mengen erkannt"]
    assert result["recipe_empty"] is False
    assert result["empty_reason"] is None


def test_extraction_confidence_shape() -> None:
    """Confidence block: overall level + free-form notes."""
    conf: ExtractionConfidence = {"overall": "low", "notes": []}
    assert conf["overall"] == "low"
    assert conf["notes"] == []


def test_nutrition_estimate_shape() -> None:
    """Per-portion nutrition estimate: four integers."""
    estimate: NutritionEstimate = {
        "kcal": 420,
        "protein_g": 24,
        "carbs_g": 38,
        "fat_g": 9,
    }
    assert estimate["kcal"] == 420
    assert estimate["protein_g"] == 24
    assert estimate["carbs_g"] == 38
    assert estimate["fat_g"] == 9


def test_extracted_recipe_accepts_nutrition_estimate() -> None:
    """``ExtractedRecipe`` carries an optional per-portion estimate."""
    recipe: ExtractedRecipe = {
        "title": "Testrezept",
        "description": None,
        "servings": 4,
        "difficulty": None,
        "prep_minutes": None,
        "cook_minutes": None,
        "ingredients": [],
        "steps": [],
        "tags": [],
        "source_url": "https://example.com/x",
        "thumbnail_url": None,
        "nutrition_estimate": {
            "kcal": 300,
            "protein_g": 10,
            "carbs_g": 30,
            "fat_g": 8,
        },
    }
    assert recipe["nutrition_estimate"] is not None
    assert recipe["nutrition_estimate"]["kcal"] == 300


def test_extracted_recipe_accepts_null_nutrition_estimate() -> None:
    """Explicit ``None`` is valid — "LLM could not estimate"."""
    recipe: ExtractedRecipe = {
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
    assert recipe["nutrition_estimate"] is None
