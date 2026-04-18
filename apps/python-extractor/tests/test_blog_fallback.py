"""Tests for the BS4 plain-text fallback layer of the blog extractor."""

from __future__ import annotations

from pathlib import Path

from extractor.pipeline.blog import extract_bs4_fallback

_FIXTURE_DIR = Path(__file__).parent / "fixtures" / "blog"


def _load(name: str) -> str:
    return (_FIXTURE_DIR / name).read_text(encoding="utf-8")


def test_fallback_returns_article_text() -> None:
    """When <article> is present, fallback prefers it over <body>."""
    html = _load("fallback_bare.html")
    text = extract_bs4_fallback(html)
    assert "Apfelkuchen vom Blech" in text
    assert "500 g Mehl" in text


def test_fallback_strips_scripts_and_styles() -> None:
    """<script> and <style> content is never emitted as text."""
    html = _load("fallback_bare.html")
    text = extract_bs4_fallback(html)
    assert "alert" not in text
    assert "background: white" not in text


def test_fallback_collapses_whitespace() -> None:
    """Successive blank lines collapse so the prompt stays compact."""
    html = "<html><body><p>hello</p>\n\n\n\n<p>world</p></body></html>"
    text = extract_bs4_fallback(html)
    # No triple-newline run should survive.
    assert "\n\n\n" not in text
    assert "hello" in text
    assert "world" in text


def test_fallback_returns_empty_string_for_empty_html() -> None:
    """Empty input doesn't crash; returns empty string."""
    assert extract_bs4_fallback("") == ""


def test_fallback_falls_back_to_main_then_body() -> None:
    """When <article> is absent, <main> is next; finally <body>."""
    html = "<html><body><main><p>Main-Abschnitt</p></main></body></html>"
    assert "Main-Abschnitt" in extract_bs4_fallback(html)

    html2 = "<html><body><p>Nur-Body</p></body></html>"
    assert "Nur-Body" in extract_bs4_fallback(html2)
