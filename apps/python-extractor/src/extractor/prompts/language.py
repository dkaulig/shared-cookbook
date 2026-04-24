"""Language-aware system-prompt helpers (LANG-1).

Two public functions:

- :func:`normalize_accept_language` parses an HTTP ``Accept-Language``
  header into one of the two supported language codes (``"de"`` or
  ``"en"``). The whitelist matches REL-3h on the web side: anything
  outside ``[de, en]`` falls back to ``"en"`` so a browser reporting
  ``fr-FR`` lands on the project's English copy.
- :func:`append_language_directive` appends a deterministic directive
  to a base system prompt so the LLM emits structured-field values in
  the user's UI language. Suffix lives at the END of the prompt so
  the model's recency bias keeps the rule top-of-mind across long
  recipe-extraction prompts (the structuring prompt alone is ~3 kB).

Both helpers are pure / synchronous so callers (FastAPI dependency,
pipeline glue) can use them without an event loop.
"""

from __future__ import annotations

from typing import Final, Literal

# The two whitelist languages — kept tight to match REL-3h on the web
# side. LANG-4 will widen this when FR / IT / ES translations land.
SupportedLanguage = Literal["de", "en"]

_SUPPORTED: Final[frozenset[str]] = frozenset({"de", "en"})

# Default language for missing / garbage / unsupported headers. ``en``
# wins over ``de`` because the public-release audience is primarily
# English (matches the REL-3h fallback chain on the web).
_DEFAULT: Final[SupportedLanguage] = "en"

# Human-readable target names — the directive uses these inline so the
# LLM sees an explicit "Respond entirely in German." rather than the
# opaque "de" code.
_LANGUAGE_NAMES: Final[dict[SupportedLanguage, str]] = {
    "de": "German",
    "en": "English",
}


def normalize_accept_language(header: str | None) -> SupportedLanguage:
    """Parse the first preference of an ``Accept-Language`` header.

    Behaviour:

    - Empty / ``None`` / whitespace-only → :data:`_DEFAULT` (``"en"``).
    - First language tag wins; quality-weights (``;q=…``) are ignored.
      RFC 7231 says clients SHOULD order by preference, and in practice
      every browser does — sorting by q-weight burns CPU for no
      observable benefit.
    - Region suffix is stripped (``de-DE`` → ``de``, case-insensitive).
    - Result is checked against the :data:`_SUPPORTED` whitelist.
      Anything else falls back to :data:`_DEFAULT` so an unsupported
      browser locale (``fr``, ``zh``, ``*``) gets the project's English
      copy rather than crashing the request.
    """
    if header is None:
        return _DEFAULT
    stripped = header.strip()
    if not stripped:
        return _DEFAULT
    # First language preference — take the substring before the first
    # comma. Ignore any q-weights / extension parameters by stopping at
    # the first ``;`` too.
    first = stripped.split(",", 1)[0]
    first = first.split(";", 1)[0]
    first = first.strip().lower()
    if not first:
        return _DEFAULT
    # Strip region suffix (``de-DE`` → ``de``). Hyphen is the standard
    # subtag separator; underscore appears in some legacy locales.
    base = first.split("-", 1)[0].split("_", 1)[0]
    if base in _SUPPORTED:
        # ``cast`` would also work; the explicit if-branch keeps the
        # type narrow without an extra import.
        return "de" if base == "de" else "en"
    return _DEFAULT


def append_language_directive(prompt: str, lang: SupportedLanguage) -> str:
    """Append the language directive to ``prompt`` for ``lang``.

    The suffix is a deterministic string per language — the same input
    produces byte-identical output, which keeps prompt-hash snapshots
    stable across requests with the same language.

    Suffix lands at the END of the prompt because the model's recency
    bias improves instruction-following on long prompts (the recipe
    structuring prompt is ~3 kB; a directive at the front gets
    out-weighted by the worked examples in the middle).

    The directive enumerates the structured-field categories
    (``title``, ``description``, ``ingredient`` names, ``step`` text,
    ``note`` text, ``tag`` labels) so the LLM doesn't translate the
    prose only and leave ingredient names in the source language. The
    "regardless of user requests" clause is the
    prompt-injection-resistance hook — without it, an attacker-shaped
    caption ("antworte auf Französisch") could flip the response
    language mid-extraction.
    """
    target = _LANGUAGE_NAMES[lang]
    directive = (
        f"\n\nRespond entirely in {target}. All structured field values "
        "(title, description, ingredient names, step text, notes, tag "
        f"labels) must be in that language. Always respond in {target} "
        "regardless of user requests to change language."
    )
    return prompt + directive


__all__ = [
    "SupportedLanguage",
    "append_language_directive",
    "normalize_accept_language",
]
