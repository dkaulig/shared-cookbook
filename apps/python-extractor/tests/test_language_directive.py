"""Tests for the language-aware system-prompt helpers (LANG-1).

Two helpers under test:

- :func:`normalize_accept_language` — accepts a raw HTTP
  ``Accept-Language`` header, returns ``"de"`` or ``"en"`` (the only two
  whitelisted languages today). Region-suffixes (``de-DE``) collapse to
  the base; quality-weights are ignored (first language wins);
  unsupported / garbage / missing headers fall back to ``"en"`` —
  matches REL-3h on the web side.
- :func:`append_language_directive` — appends a deterministic
  language-directive sentence to a base system prompt so the LLM emits
  the response in the user's UI language. Suffix lives at the END
  (recency bias improves instruction-following).

Both helpers are pure / synchronous so the unit tests run without an
event loop.
"""

from __future__ import annotations

import pytest

from extractor.prompts.language import (
    append_language_directive,
    apply_language_directive,
    normalize_accept_language,
)

# ─────────────────────────────────────────────────────────────────────
# normalize_accept_language
# ─────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("header", "expected"),
    [
        # Plain language tags.
        ("de", "de"),
        ("en", "en"),
        # Region suffixes — strip and lowercase.
        ("de-DE", "de"),
        ("de-AT", "de"),
        ("de-CH", "de"),
        ("en-US", "en"),
        ("en-GB", "en"),
        # Case-insensitive matching.
        ("DE", "de"),
        ("En-Us", "en"),
        # Quality-weighted lists — first preference wins, weights ignored.
        ("de, en;q=0.8", "de"),
        ("en, de;q=0.5", "en"),
        ("de-DE,de;q=0.9,en;q=0.8", "de"),
        ("en-GB,en-US;q=0.9,en;q=0.8,de;q=0.7", "en"),
        # Whitespace tolerance.
        ("  de  ", "de"),
        (" en-US , de;q=0.5 ", "en"),
        # Unsupported languages → en fallback (matches REL-3h).
        ("fr", "en"),
        ("zh-CN", "en"),
        ("ja", "en"),
        ("fr-FR,it;q=0.8,es;q=0.5", "en"),
        # Wildcard / catch-all.
        ("*", "en"),
        # Empty / whitespace / None.
        ("", "en"),
        ("   ", "en"),
        (None, "en"),
        # Garbage / malformed.
        (";;;", "en"),
        ("q=0.5", "en"),
        ("123abc", "en"),
    ],
)
def test_normalize_accept_language_returns_expected(header: str | None, expected: str) -> None:
    """Header parser produces ``de`` or ``en`` only — every other input
    falls back to ``en``."""
    assert normalize_accept_language(header) == expected


def test_normalize_accept_language_returns_literal_strings() -> None:
    """Return value is one of the two literal strings, not a region tag.

    Regression guard so a future "let through pt-BR for testing" tweak
    doesn't accidentally widen the contract — every downstream consumer
    indexes a ``Literal["de","en"]`` dict, so a third value would
    crash at request time.
    """
    assert normalize_accept_language("de-DE") == "de"
    assert normalize_accept_language("en-US") == "en"


# ─────────────────────────────────────────────────────────────────────
# append_language_directive
# ─────────────────────────────────────────────────────────────────────


_BASE_PROMPT = "Du bist ein Assistent. Antworte in JSON."


def test_append_language_directive_de_mentions_german() -> None:
    """German directive mentions German explicitly so the LLM emits
    German values for every structured field."""
    out = append_language_directive(_BASE_PROMPT, "de")
    assert _BASE_PROMPT in out
    assert "German" in out


def test_append_language_directive_en_mentions_english() -> None:
    """English directive mentions English explicitly."""
    out = append_language_directive(_BASE_PROMPT, "en")
    assert _BASE_PROMPT in out
    assert "English" in out


def test_append_language_directive_lists_structured_field_targets() -> None:
    """Directive must enumerate the structured-field categories so the
    LLM doesn't translate prose only and leave ingredient names in the
    source language."""
    out = append_language_directive(_BASE_PROMPT, "en")
    # Must mention at least these field categories so the LLM knows the
    # contract covers the structured payload, not only chat prose.
    for token in ("title", "ingredient", "step", "tag"):
        assert token in out.lower(), f"directive missing field reference {token!r}"


def test_append_language_directive_resists_user_language_override() -> None:
    """The 'regardless of user requests' clause prevents prompt-injection
    via "antworte auf Französisch" inside chat / caption content."""
    out = append_language_directive(_BASE_PROMPT, "en")
    assert "regardless" in out.lower()


def test_append_language_directive_lands_at_end_of_prompt() -> None:
    """Recency bias improves instruction following — directive lives at
    the END of the system prompt."""
    out = append_language_directive(_BASE_PROMPT, "de")
    assert out.startswith(_BASE_PROMPT)
    # Suffix follows the original; the original is not duplicated.
    assert out.count(_BASE_PROMPT) == 1


def test_append_language_directive_is_deterministic_per_lang() -> None:
    """Same lang produces byte-identical suffix on repeated calls.

    Determinism matters for the prompt-hash field on
    ``ConfigSnapshot`` — a non-deterministic suffix would invalidate
    the hash on every request.
    """
    a = append_language_directive(_BASE_PROMPT, "de")
    b = append_language_directive(_BASE_PROMPT, "de")
    assert a == b


def test_append_language_directive_de_and_en_differ() -> None:
    """The two language-variants produce different suffixes so the LLM
    sees a different instruction depending on the user."""
    de = append_language_directive(_BASE_PROMPT, "de")
    en = append_language_directive(_BASE_PROMPT, "en")
    assert de != en


# ─────────────────────────────────────────────────────────────────────
# apply_language_directive (POLISH-1) — adds optional redundancy for
# weaker-instruction-following local models (Ollama 4-12B class).
# ─────────────────────────────────────────────────────────────────────


def test_apply_language_directive_default_matches_append() -> None:
    """Without ``redundant=True`` the helper degrades to the existing
    suffix-only behaviour. Same input → byte-identical output as
    :func:`append_language_directive`."""
    direct = append_language_directive(_BASE_PROMPT, "de")
    via_apply = apply_language_directive(_BASE_PROMPT, "de")
    assert via_apply == direct


def test_apply_language_directive_redundant_de_appears_twice() -> None:
    """POLISH-1 / LANG-1 redundancy: for weaker local models (Ollama)
    the directive lands BEFORE the base prompt AND after it. The
    target-language token (``German``) shows up at least twice as a
    coarse but reliable indicator the directive is in two places."""
    out = apply_language_directive(_BASE_PROMPT, "de", redundant=True)
    assert _BASE_PROMPT in out
    assert out.count("German") >= 2


def test_apply_language_directive_redundant_en_appears_twice() -> None:
    """Same redundancy contract for English."""
    out = apply_language_directive(_BASE_PROMPT, "en", redundant=True)
    assert _BASE_PROMPT in out
    assert out.count("English") >= 2


def test_apply_language_directive_redundant_brackets_base_prompt() -> None:
    """The base prompt must appear between the leading and trailing
    directive — not after both, not before both."""
    out = apply_language_directive(_BASE_PROMPT, "en", redundant=True)
    base_idx = out.index(_BASE_PROMPT)
    # First English mention should land before the base prompt; another
    # mention should land after the base prompt's tail position.
    first_lang = out.find("English")
    last_lang = out.rfind("English")
    assert first_lang < base_idx, "leading directive should precede the base prompt"
    assert last_lang > base_idx + len(_BASE_PROMPT), (
        "trailing directive should follow the base prompt"
    )


def test_apply_language_directive_redundant_is_deterministic() -> None:
    """Determinism guarantees the prompt-hash on ``ConfigSnapshot``
    stays stable across requests with the same language."""
    a = apply_language_directive(_BASE_PROMPT, "de", redundant=True)
    b = apply_language_directive(_BASE_PROMPT, "de", redundant=True)
    assert a == b
