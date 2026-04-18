"""Tests for the JSON-LD layer of the blog extractor."""

from __future__ import annotations

from pathlib import Path

from extractor.pipeline.blog import extract_jsonld

_FIXTURE_DIR = Path(__file__).parent / "fixtures" / "blog"


def _load(name: str) -> str:
    """Read an HTML fixture file from tests/fixtures/blog/."""
    return (_FIXTURE_DIR / name).read_text(encoding="utf-8")


def test_extract_jsonld_returns_dict_on_happy_path() -> None:
    """A page carrying schema.org/Recipe JSON-LD is picked up."""
    html = _load("jsonld_spaghetti.html")
    result = extract_jsonld(html)
    assert result is not None
    assert result["name"] == "Spaghetti Carbonara"


def test_extract_jsonld_includes_ingredients_and_steps() -> None:
    """Ingredients + instructions pass through verbatim."""
    html = _load("jsonld_spaghetti.html")
    result = extract_jsonld(html)
    assert result is not None
    ingredients = result["recipeIngredient"]
    assert "400 g Spaghetti" in ingredients
    assert "200 g Guanciale" in ingredients


def test_extract_jsonld_returns_none_when_no_recipe_ld() -> None:
    """A page without any JSON-LD Recipe block returns None."""
    html = _load("fallback_bare.html")
    assert extract_jsonld(html) is None


def test_extract_jsonld_tolerates_malformed_html() -> None:
    """Broken HTML (unclosed tags) doesn't crash — returns None cleanly."""
    html = "<html><head><title>oops"
    assert extract_jsonld(html) is None
