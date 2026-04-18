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
    ConfidenceLevel,
    ExtractedIngredient,
    ExtractedRecipe,
    ExtractedStep,
    ExtractionConfidence,
    ExtractionResult,
    IngredientConfidenceLevel,
)


def test_confidence_level_literal_contains_expected_values() -> None:
    """``high | medium | low`` — the three levels our frontend renders."""
    assert set(get_args(ConfidenceLevel)) == {"high", "medium", "low"}


def test_ingredient_confidence_level_literal_adds_missing() -> None:
    """Ingredients can also be ``missing`` — frontend highlights for review."""
    assert set(get_args(IngredientConfidenceLevel)) == {
        "high",
        "medium",
        "low",
        "missing",
    }


def test_confidence_levels_tuple_matches_literal() -> None:
    """Runtime-accessible tuple stays in sync with the literal."""
    assert set(CONFIDENCE_LEVELS) == set(get_args(ConfidenceLevel))


def test_ingredient_confidence_levels_tuple_matches_literal() -> None:
    """Runtime-accessible tuple stays in sync with the literal."""
    assert set(INGREDIENT_CONFIDENCE_LEVELS) == set(get_args(IngredientConfidenceLevel))


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
        },
        "confidence": {"overall": "medium", "notes": ["Keine Mengen erkannt"]},
    }
    assert result["recipe"]["title"] == "Kaiserschmarrn"
    assert result["confidence"]["overall"] == "medium"
    assert result["confidence"]["notes"] == ["Keine Mengen erkannt"]


def test_extraction_confidence_shape() -> None:
    """Confidence block: overall level + free-form notes."""
    conf: ExtractionConfidence = {"overall": "low", "notes": []}
    assert conf["overall"] == "low"
    assert conf["notes"] == []
