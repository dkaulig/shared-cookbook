"""Three-layer blog-page → structured / text extractor.

The pipeline runs the layers in order of specificity; the first one
that returns a non-``None`` value wins. All three layers are always
required (per plan) — they are complementary, not redundant:

1. :func:`extract_jsonld` — pulls ``schema.org/Recipe`` JSON-LD blocks
   from the HTML via ``extruct``. Highest-quality structured data; most
   major cooking sites embed this.
2. :func:`extract_recipe_scrapers` — hand-rolled per-domain parsers in
   ``recipe-scrapers``. Covers sites without JSON-LD and sites with
   non-standard markup (1000+ domains).
3. :func:`extract_bs4_fallback` — ``BeautifulSoup`` + ``lxml`` plain-
   text dump of ``<article>`` / ``<main>`` / ``<body>`` in that order.
   Always returns a string (even if empty), so downstream code can
   still pass the raw text to the LLM.

The layers return heterogeneous shapes because each has its own data
model:

- ``extract_jsonld`` → the raw JSON-LD ``Recipe`` object as a ``dict``
  (schema.org vocabulary).
- ``extract_recipe_scrapers`` → a flattened ``dict`` we control with
  keys ``title`` / ``description`` / ``ingredients`` / ``instructions``
  / ``yields`` / ``total_time`` / ``image``.
- ``extract_bs4_fallback`` → plain text.

The orchestrator in :mod:`extractor.pipeline.url` is responsible for
flattening these into the uniform LLM user-message input — this module
just extracts and stays dumb.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Final

# ``extruct`` doesn't ship PEP 561 stubs; add a module-scoped ignore
# with a named reason rather than per-import ``type: ignore`` noise.
import extruct  # type: ignore[import-untyped]  # no py.typed marker upstream
from bs4 import BeautifulSoup
from recipe_scrapers import scrape_html
from recipe_scrapers._exceptions import RecipeScrapersExceptions

logger = logging.getLogger("extractor.pipeline.blog")


# ─────────────────────────────────────────────────────────────────────
# Layer 1 — JSON-LD via extruct
# ─────────────────────────────────────────────────────────────────────


def extract_jsonld(html: str) -> dict[str, Any] | None:
    """Return the first schema.org ``Recipe`` JSON-LD block, or ``None``.

    Uses ``extruct`` with ``errors="ignore"`` so malformed blocks on
    the same page don't break the one we care about. Walks the
    ``@type`` field to tolerate both ``"Recipe"`` (string) and
    ``["Recipe", "NewsArticle"]`` (list) shapes that show up in the
    wild.
    """
    if not html:
        return None
    try:
        extracted = extruct.extract(
            html,
            syntaxes=["json-ld"],
            uniform=True,
            errors="ignore",
        )
    except (ValueError, TypeError) as exc:
        # extruct can raise on very broken HTML even with errors=ignore
        # at the JSON-decode layer. We log + fall through.
        logger.debug("extruct JSON-LD parse failed: %s", type(exc).__name__)
        return None

    jsonld_blocks = extracted.get("json-ld") or []
    for block in jsonld_blocks:
        if not isinstance(block, dict):
            continue
        type_value = block.get("@type")
        if _is_recipe_type(type_value):
            return dict(block)
    return None


def _is_recipe_type(type_value: Any) -> bool:
    """Accept both ``"Recipe"`` string and ``[..., "Recipe", ...]`` list forms."""
    if isinstance(type_value, str):
        return type_value == "Recipe"
    if isinstance(type_value, list):
        return any(isinstance(v, str) and v == "Recipe" for v in type_value)
    return False


# ─────────────────────────────────────────────────────────────────────
# Layer 2 — recipe-scrapers (per-domain parsers)
# ─────────────────────────────────────────────────────────────────────


def extract_recipe_scrapers(url: str, html: str) -> dict[str, Any] | None:
    """Run ``recipe-scrapers`` against the URL+HTML.

    Returns a flattened dict (never the raw scraper object — that shape
    is unstable across versions). Returns ``None`` when:

    - the domain isn't supported (``WebsiteNotImplementedError``);
    - the scraper raises any ``RecipeScrapersExceptions`` subclass
      (malformed page, missing required field, etc.);
    - the HTML is syntactically broken (catches the ``ValueError`` /
      ``TypeError`` from bs4's underlying parsers).
    """
    if not html:
        return None
    try:
        scraper = scrape_html(html, org_url=url, supported_only=True)
    except RecipeScrapersExceptions as exc:
        logger.debug("recipe-scrapers setup rejected: %s", type(exc).__name__)
        return None
    except (ValueError, TypeError) as exc:
        logger.debug("recipe-scrapers HTML parse failed: %s", type(exc).__name__)
        return None

    # Each getter can raise its own exception when the field is missing
    # on the page. We're defensive: anything that raises becomes the
    # safe default. The scraper itself is worth keeping even if one
    # field fails — we might still recover ingredients from a page with
    # a missing title, etc.
    result: dict[str, Any] = {
        "title": _safe_call(scraper.title) or "",
        "description": _safe_call(scraper.description),
        "ingredients": _safe_call(scraper.ingredients) or [],
        "instructions": _safe_call(scraper.instructions) or "",
        "yields": _safe_call(scraper.yields),
        "total_time": _safe_call(scraper.total_time),
        "image": _safe_call(scraper.image),
    }

    # If we failed on everything, there's nothing to return.
    if not result["title"] and not result["ingredients"] and not result["instructions"]:
        return None
    return result


def _safe_call(getter: Any) -> Any:
    """Call a recipe-scrapers getter and swallow its documented exceptions.

    Returns ``None`` when any of the two exception families fire:
    - ``RecipeScrapersExceptions`` (field-missing, element-not-found, …)
    - ``ValueError`` / ``TypeError`` / ``AttributeError`` from the
      underlying parsers when the page is broken.
    """
    try:
        return getter()
    except RecipeScrapersExceptions:
        return None
    except (ValueError, TypeError, AttributeError):
        return None


# ─────────────────────────────────────────────────────────────────────
# Layer 3 — BeautifulSoup plain-text fallback
# ─────────────────────────────────────────────────────────────────────

_WHITESPACE_RUN = re.compile(r"\n{3,}")


def extract_bs4_fallback(html: str) -> str:
    """Plain-text dump of the most-content-rich container.

    Prefers ``<article>`` → ``<main>`` → ``<body>`` in that order.
    Strips ``<script>`` and ``<style>`` content. Collapses runs of 3+
    newlines to 2 so the LLM prompt stays compact.

    Returns an empty string for empty / unparsable input; never raises.
    """
    if not html:
        return ""

    try:
        soup = BeautifulSoup(html, "lxml")
    except (ValueError, TypeError):
        # lxml's parser very rarely raises on edge cases; fall back to
        # the pure-Python parser which is more lenient.
        try:
            soup = BeautifulSoup(html, "html.parser")
        except (ValueError, TypeError):
            return ""

    # Remove noise.
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()

    container = soup.find("article") or soup.find("main") or soup.find("body") or soup
    text = container.get_text(separator="\n", strip=True)
    return _WHITESPACE_RUN.sub("\n\n", text)


# ─────────────────────────────────────────────────────────────────────
# COVER-0 slice A — JSON-LD image-candidate flattener
# ─────────────────────────────────────────────────────────────────────

# COVER-0 cap: maximum number of candidate thumbnails emitted per
# recipe. 6 matches the UX (3x2 grid) and bounds slice B's backend
# download storm at <= 6 * 5 MB per import. Slice A only returns URLs —
# no fetches happen here — so the cap is about hand-off hygiene, not
# in-process memory.
_CANDIDATE_THUMBNAIL_CAP: Final[int] = 6


def flatten_jsonld_image_candidates(jsonld: dict[str, Any]) -> list[str]:
    """Collapse schema.org ``image`` into an ordered ``list[str]``.

    Schema.org Recipe allows four shapes for ``image``:

    - ``"https://…"`` — single URL string.
    - ``["a", "b", …]`` — array of URL strings.
    - ``{"url": "https://…"}`` — ``ImageObject`` dict.
    - ``[{"url": "a"}, {"url": "b"}]`` — array of ``ImageObject``.

    The flattener accepts all four and returns a ``list[str]`` in
    input order (first image wins as the default cover). Non-string /
    non-object entries inside an array are dropped silently —
    downstream the .NET-side candidate attacher applies the SSRF
    allowlist + download caps anyway, so we stay lenient here.

    Empty / whitespace-only URLs are dropped because they'd render a
    broken tile. Duplicates collapse to their first-seen occurrence.

    The result is capped at :data:`_CANDIDATE_THUMBNAIL_CAP` — a malicious
    JSON-LD blog could otherwise plant a 1000-entry array and we'd hand
    that to slice B's downloader. Slice A only *returns* URLs (no
    fetches), so the cap is about giving slice B a bounded list.
    """
    raw = jsonld.get("image")
    urls: list[str] = []
    seen: set[str] = set()

    def _append(candidate: Any) -> bool:
        """Return True once the cap is reached so the outer loop can
        short-circuit and not iterate through a 10k-entry hostile
        array.
        """
        if not isinstance(candidate, str):
            return False
        stripped = candidate.strip()
        if not stripped or stripped in seen:
            return False
        seen.add(stripped)
        urls.append(stripped)
        return len(urls) >= _CANDIDATE_THUMBNAIL_CAP

    if isinstance(raw, str):
        _append(raw)
    elif isinstance(raw, list):
        for entry in raw:
            if isinstance(entry, str) and _append(entry):
                break
            if isinstance(entry, dict) and _append(entry.get("url")):
                break
    elif isinstance(raw, dict):
        _append(raw.get("url"))

    return urls


__all__ = [
    "extract_bs4_fallback",
    "extract_jsonld",
    "extract_recipe_scrapers",
    "flatten_jsonld_image_candidates",
]
