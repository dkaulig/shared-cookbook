"""Tests for the recipe-scrapers layer of the blog extractor."""

from __future__ import annotations

from pathlib import Path

from extractor.pipeline.blog import extract_recipe_scrapers

_FIXTURE_DIR = Path(__file__).parent / "fixtures" / "blog"


def _load(name: str) -> str:
    return (_FIXTURE_DIR / name).read_text(encoding="utf-8")


def test_recipe_scrapers_extracts_title_ingredients_instructions() -> None:
    """chefkoch.de is a supported domain — the scraper returns a
    structured dict with title + ingredients + instructions."""
    html = _load("scraper_chefkoch.html")
    result = extract_recipe_scrapers("https://www.chefkoch.de/rezepte/linsensuppe", html)
    assert result is not None
    assert result["title"] == "Linsensuppe"
    assert "500 g Linsen" in result["ingredients"]
    assert "instructions" in result
    assert len(result["instructions"]) > 0


def test_recipe_scrapers_returns_none_for_unsupported_domain() -> None:
    """An unsupported domain without JSON-LD returns None rather than
    raising — so the caller can fall through to the BS4 fallback."""
    html = _load("fallback_bare.html")
    result = extract_recipe_scrapers("https://unknown-food-blog.example.com/apfelkuchen", html)
    assert result is None


def test_recipe_scrapers_returns_none_on_parser_error() -> None:
    """Malformed HTML → None (not an exception)."""
    result = extract_recipe_scrapers("https://www.chefkoch.de/nope", "<html>oops")
    assert result is None
