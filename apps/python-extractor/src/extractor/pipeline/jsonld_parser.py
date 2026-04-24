"""REL-8 — JSON-LD Recipe parser as a pre-LLM branch.

Most food blogs embed a ``schema.org/Recipe`` entity in a
``<script type="application/ld+json">`` block. Directly mapping that to
our extractor output is more accurate than a round-trip through the LLM
and costs zero tokens, so the URL-import pipeline calls this module
*before* dispatching to the LLM. When a Recipe block is present and
passes the minimum-validity gate (title + >= 1 ingredient + >= 1 step),
the pipeline uses the mapped payload verbatim and skips the LLM. When
any of those conditions fail, :func:`extract_recipe_from_html` returns
``None`` and the pipeline falls through to the existing LLM branch.

Works with AND without AI:

- ``llm.provider = azure / ollama``: JSON-LD preempts the LLM call on
  blogs that carry it. More accurate, cheaper, faster.
- ``llm.provider`` absent: JSON-LD is the only structured-import path
  for blog URLs. Social-video captions (FB / IG) carry no JSON-LD so
  they still fall through to the raw-text path.

The parser maps onto the same ``llm_output`` dict shape that
:class:`extractor.llm.azure_openai.AzureOpenAIProvider` returns. That
shape is then fed through :func:`extractor.pipeline.post_process.post_process`
so the defensive clamp / normalisation suite applies for free -- we
don't re-implement servings clamping, tag dedup, mass-leak guards, etc.

Field mapping (schema.org -> our llm_output):

- ``name`` -> ``title``
- ``description`` -> ``description``
- ``recipeIngredient[]`` -> ``components[0].ingredients[]``
  (each line regex-parsed into ``{quantity, unit, name, raw}``)
- ``recipeInstructions`` -> ``components[0].steps[]``
  (accepts prose string, array of strings, array of HowToStep dicts,
  nested HowToSection.itemListElement -- all flattened)
- ``recipeYield`` -> ``servings`` (int or string, range -> first int)
- ``prepTime`` / ``cookTime`` (ISO 8601 duration) -> ``prep_minutes`` /
  ``cook_minutes``
- ``recipeCategory`` / ``keywords`` -> ``tags`` (post_process lowercases
  + dedupes)
- ``nutrition.calories`` / ``proteinContent`` / ``carbohydrateContent`` /
  ``fatContent`` -> ``nutrition_estimate.kcal`` / ``protein_g`` /
  ``carbs_g`` / ``fat_g`` (numeric-parse with unit stripping)
- ``image`` -- NOT mapped here; the pipeline already handles
  thumbnail + candidate_thumbnails via
  :func:`extractor.pipeline.blog.flatten_jsonld_image_candidates`.
- ``author`` -- ignored; untrusted HTML, never mapped onto the
  recipe-owner field. Our single-user app owns every recipe by design.

Security guards:

- Hard cap on HTML input size (5 MiB) to prevent memory DoS on a
  pathologically large blog page.
- Hard cap per JSON-LD script block (100 KiB) to prevent a deeply
  nested / giant JSON blob from eating the budget. Oversize blocks are
  skipped; other in-budget blocks on the same page still get a chance.
- Defensive ``json.loads`` -- every block is wrapped in try/except so
  one malformed block doesn't break scanning. Recursion depth of the
  parser uses Python's default sys-level limit; the parser only
  traverses fixed fields (``@type`` / ``recipeInstructions`` /
  ``@graph``), not arbitrary nested structures.
- No LLM is called on JSON-LD content, so there is NO prompt-injection
  vector here -- a malicious blog that tries to smuggle ``"ignore
  previous instructions"`` into ``recipeIngredient`` just ends up as a
  weird ingredient name in the DB, nothing more.
- Ingredient-line regex is linear (no nested quantifiers); ReDoS-safe
  on arbitrary attacker input.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Final, TypedDict

from extractor.pipeline.blog import extract_jsonld

logger = logging.getLogger("extractor.pipeline.jsonld_parser")


# Security caps -- REL-8 /security review.
_MAX_HTML_BYTES: Final[int] = 5 * 1024 * 1024  # 5 MiB on the whole page
_MAX_JSONLD_BLOCK_BYTES: Final[int] = 100 * 1024  # 100 KiB per <script>
# Mirrors the JSON-LD-RECIPE-SCHEMA caps in
# :mod:`extractor.prompts.recipe_extraction` so a hostile JSON-LD blob
# can't flood the DB with 10000 entries. The post_process pipeline
# normalises the LLM side via the Azure strict-mode schema already, but
# the pre-LLM branch bypasses that enforcement, so we cap here.
_MAX_INGREDIENTS_PER_RECIPE: Final[int] = 100
_MAX_STEPS_PER_RECIPE: Final[int] = 30


# Matches any <script type="application/ld+json">...</script> block.
# ``re.DOTALL`` lets ``.*?`` span newlines; ``.*?`` is non-greedy so we
# stop at the first closing tag. Bounded by the 5 MiB whole-page cap
# above -- the regex itself is linear so there is no catastrophic
# backtracking.
_JSONLD_BLOCK_RE: Final[re.Pattern[str]] = re.compile(
    r'<script[^>]*type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
    re.IGNORECASE | re.DOTALL,
)


# ---------------------------------------------------------------------
# Ingredient-line parser
# ---------------------------------------------------------------------


class IngredientLineParse(TypedDict):
    """Parsed view of a ``recipeIngredient`` line."""

    quantity: str | None
    unit: str | None
    name: str
    raw: str


# Units we recognise as such -- these are the only strings that count as
# a unit in the "<qty> <maybe unit> <name>" split. An unrecognised token
# in the unit slot is demoted to part of the name (so "3 Eier" ->
# quantity=3, unit=None, name=Eier).
#
# Matched case-insensitively. Order inside the tuple doesn't matter for
# correctness but the layout keeps related units visually grouped.
_KNOWN_UNITS: Final[frozenset[str]] = frozenset(
    s.lower()
    for s in (
        # Metric mass
        "g",
        "kg",
        "mg",
        # Metric volume
        "ml",
        "l",
        "dl",
        "cl",
        # Imperial mass
        "oz",
        "ounce",
        "ounces",
        "lb",
        "lbs",
        "pound",
        "pounds",
        # Imperial volume
        "cup",
        "cups",
        "tsp",
        "tsps",
        "teaspoon",
        "teaspoons",
        "tbsp",
        "tbsps",
        "tablespoon",
        "tablespoons",
        "fl",  # for "fl oz" (handled as two-token unit below)
        # German count-like
        "el",
        "tl",
        "stück",
        "stueck",
        "prise",
        "prisen",
        "bund",
        "tasse",
        "tassen",
        "becher",
        "scheibe",
        "scheiben",
        "zehe",
        "zehen",
        "teelöffel",
        "teeloeffel",
        "esslöffel",
        "essloeffel",
        # English count-like
        "pinch",
        "pinches",
        "clove",
        "cloves",
        "slice",
        "slices",
        "bunch",
        "bunches",
        "piece",
        "pieces",
        "stick",
        "sticks",
    )
)


# Quantity regex: captures the leading numeric group (int, decimal with
# ``.`` or ``,``, ASCII fraction ``1/2``, mixed number ``1 1/2``, or a
# single Unicode vulgar-fraction codepoint). The pattern is anchored at
# the start and linear -- no catastrophic backtracking.
#
# Ordering matters inside the alternation: mixed numbers ``1 1/2`` must
# be tried before the bare decimal ``1`` or the bare fraction ``1/2``.
_QUANTITY_RE: Final[re.Pattern[str]] = re.compile(
    r"""
    ^\s*
    (                               # group 1: the quantity token
        \d+\s+\d+/\d+               # mixed number: "1 1/2"
        | \d+/\d+                   # plain fraction: "1/2"
        | \d+[.,]\d+                # decimal with "." or ",": "0,25" or "1.5"
        | \d+                       # plain integer: "500"
        | [¼½¾⅓⅔⅕⅖⅗⅘⅙⅚⅐⅛⅜⅝⅞⅑⅒]  # single Unicode vulgar fraction
    )
    \s+                             # mandatory separator
    (.*)                            # group 2: rest of the line
    $
    """,
    re.VERBOSE,
)


def parse_ingredient_line(raw: str) -> IngredientLineParse:
    """Split an ingredient line into ``{quantity, unit, name, raw}``.

    Rules:

    - Leading numeric token (int / decimal / fraction / mixed / Unicode
      fraction) becomes ``quantity``; the rest is re-tokenised.
    - Next token is inspected against :data:`_KNOWN_UNITS`
      (case-insensitive). If it's a known unit, it becomes ``unit`` and
      the remainder becomes ``name``. Two-token units like ``fl oz`` are
      handled by checking the pair after the single-token check fails.
    - If the line has no leading quantity -> fallback: ``raw`` is kept
      verbatim and copied into ``name``; ``quantity`` and ``unit`` stay
      ``None``.
    - ``raw`` always carries the original line (trimmed of leading /
      trailing whitespace) for audit.
    """
    stripped = raw.strip()
    result: IngredientLineParse = {
        "quantity": None,
        "unit": None,
        "name": stripped,
        "raw": stripped,
    }
    if not stripped:
        return result

    match = _QUANTITY_RE.match(stripped)
    if match is None:
        # Fallback: no leading numeric -> keep whole string as name.
        return result

    quantity = match.group(1).strip()
    remainder = match.group(2).strip()
    if not remainder:
        # "500" with no rest -- rare, keep quantity, name empty.
        return {"quantity": quantity, "unit": None, "name": "", "raw": stripped}

    tokens = remainder.split(None, 2)
    first = tokens[0]
    first_lower = first.lower().rstrip(".")  # "fl." -> "fl"

    # Two-token unit check: "fl oz" / "fl. oz.".
    if len(tokens) >= 2 and first_lower == "fl":
        second_lower = tokens[1].lower().rstrip(".")
        if second_lower == "oz":
            name_tokens = tokens[2:] if len(tokens) > 2 else []
            return {
                "quantity": quantity,
                "unit": "fl oz",
                "name": " ".join(name_tokens).strip(),
                "raw": stripped,
            }

    # Single-token unit check.
    if first_lower in _KNOWN_UNITS:
        name = " ".join(tokens[1:]).strip()
        return {
            "quantity": quantity,
            "unit": first,  # preserve original casing for UI
            "name": name,
            "raw": stripped,
        }

    # No recognised unit -- the token is part of the name.
    return {
        "quantity": quantity,
        "unit": None,
        "name": remainder,
        "raw": stripped,
    }


# ---------------------------------------------------------------------
# ISO 8601 duration parser (no isodate dep -- 5-line regex)
# ---------------------------------------------------------------------

_ISO_DURATION_RE: Final[re.Pattern[str]] = re.compile(
    r"^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$"
)


def iso_duration_to_minutes(raw: str | None) -> int | None:
    """Convert an ISO 8601 duration (``PT30M``, ``PT1H15M``, ``PT2H``) to minutes.

    Returns ``None`` on malformed input or when the duration is purely
    non-temporal (e.g. ``P1Y`` -- we only support the day/hour/minute/
    second subset that schema.org prepTime / cookTime populate).

    Seconds round DOWN to the nearest minute; this matches what the
    downstream post_process + the UI expect. Days are accepted because
    occasional long-ferment recipes (bread, pickles) use ``P1DT4H``.
    """
    if not raw or not isinstance(raw, str):
        return None
    match = _ISO_DURATION_RE.match(raw.strip())
    if match is None:
        return None
    days, hours, minutes, seconds = match.groups()
    if days is None and hours is None and minutes is None and seconds is None:
        return None
    total = 0
    if days is not None:
        total += int(days) * 24 * 60
    if hours is not None:
        total += int(hours) * 60
    if minutes is not None:
        total += int(minutes)
    # Seconds: round down to minutes (floor division).
    if seconds is not None:
        total += int(seconds) // 60
    return total


# ---------------------------------------------------------------------
# Servings parser
# ---------------------------------------------------------------------

_FIRST_INT_RE: Final[re.Pattern[str]] = re.compile(r"\d+")


def parse_servings(raw: Any) -> int | None:
    """Normalise schema.org ``recipeYield`` into a positive integer.

    Accepts:

    - ``int`` directly (``4`` -> ``4``; ``0`` / negative -> ``None``).
    - ``str`` with an embedded integer (``"4"``, ``"4 Portionen"``,
      ``"Serves 4"``, ``"4-6 servings"`` -- range takes the first int).
    - ``list`` -- take the first element and recurse.
    - Anything else -> ``None``.
    """
    if isinstance(raw, bool):
        # Python treats bool as int; reject explicitly.
        return None
    if isinstance(raw, int):
        return raw if raw > 0 else None
    if isinstance(raw, list):
        if not raw:
            return None
        return parse_servings(raw[0])
    if not isinstance(raw, str):
        return None
    match = _FIRST_INT_RE.search(raw)
    if match is None:
        return None
    value = int(match.group(0))
    return value if value > 0 else None


# ---------------------------------------------------------------------
# Instruction flattener
# ---------------------------------------------------------------------


def _flatten_instructions_to_list(raw: Any) -> list[str]:
    """Schema.org ``recipeInstructions`` -> ordered list of step strings.

    Accepts:
    - String (prose) -> single-item list.
    - List of strings -> as-is (stripped, empties dropped).
    - List of ``{@type: HowToStep, text: ...}`` -> text extracted.
    - List of ``{@type: HowToSection, itemListElement: [...]}`` ->
      itemListElement recursed (mixed-depth supported).
    - Any mix of the above.

    Malformed entries (non-str, non-dict; dicts without a ``text`` and
    without an ``itemListElement``) are dropped silently -- the LLM
    fall-through will catch anything structurally hopeless.
    """
    lines: list[str] = []

    def _walk(node: Any) -> None:
        if isinstance(node, str):
            stripped = node.strip()
            if stripped:
                lines.append(stripped)
            return
        if isinstance(node, list):
            for child in node:
                _walk(child)
            return
        if isinstance(node, dict):
            node_type = node.get("@type")
            # HowToSection: recurse into itemListElement.
            if node_type == "HowToSection" or (
                isinstance(node_type, list) and "HowToSection" in node_type
            ):
                _walk(node.get("itemListElement"))
                return
            # HowToStep (or untyped dict with a ``text`` key): pull text.
            text = node.get("text")
            if isinstance(text, str):
                text_clean = text.strip()
                if text_clean:
                    lines.append(text_clean)
            return

    _walk(raw)
    return lines


# ---------------------------------------------------------------------
# Tags merge (recipeCategory + keywords)
# ---------------------------------------------------------------------


def _parse_tags(recipe: dict[str, Any]) -> list[str]:
    """Merge ``recipeCategory`` + ``keywords`` into a flat list.

    Both fields accept ``str`` (comma- or single-tag) or ``list[str]``.
    No lowercasing / dedup here -- :func:`post_process._normalise_tags`
    owns that canonicalisation step.
    """
    tags: list[str] = []

    def _absorb(value: Any) -> None:
        if isinstance(value, str):
            # Split on commas -- the most common multi-tag string shape.
            for part in value.split(","):
                clean = part.strip()
                if clean:
                    tags.append(clean)
            return
        if isinstance(value, list):
            for item in value:
                if isinstance(item, str):
                    clean = item.strip()
                    if clean:
                        tags.append(clean)

    _absorb(recipe.get("recipeCategory"))
    _absorb(recipe.get("keywords"))
    return tags


# ---------------------------------------------------------------------
# Nutrition parser
# ---------------------------------------------------------------------

_NUTRITION_FIELDS: Final[tuple[tuple[str, str], ...]] = (
    ("calories", "kcal"),
    ("proteinContent", "protein_g"),
    ("carbohydrateContent", "carbs_g"),
    ("fatContent", "fat_g"),
)


def _parse_nutrition(raw: Any) -> dict[str, int] | None:
    """Schema.org ``nutrition`` -> ``{kcal, protein_g, carbs_g, fat_g}`` or ``None``.

    Unit suffixes (``"350 kcal"``, ``"10g"``) are stripped -- we take the
    first integer in the string. Missing fields force ``None`` on the
    whole object (the post_process nutrition clamp requires all four).
    """
    if not isinstance(raw, dict):
        return None
    out: dict[str, int] = {}
    for source_key, target_key in _NUTRITION_FIELDS:
        value = raw.get(source_key)
        if value is None:
            return None
        if isinstance(value, bool):
            return None
        if isinstance(value, int):
            out[target_key] = value
            continue
        if isinstance(value, (str, float)):
            match = _FIRST_INT_RE.search(str(value))
            if match is None:
                return None
            out[target_key] = int(match.group(0))
            continue
        return None
    return out


# ---------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------


def extract_recipe_from_html(html: str) -> dict[str, Any] | None:
    """Scan ``html`` for a schema.org/Recipe JSON-LD block and map it.

    Returns a ``dict`` shaped like ``RECIPE_SCHEMA`` (the same dict
    :class:`AzureOpenAIProvider` returns) so the pipeline can feed it
    into :func:`post_process` verbatim. Returns ``None`` when:

    - ``html`` is empty / too large.
    - No ``<script type="application/ld+json">`` block contains a
      Recipe entity (via ``extruct`` -- handles ``@graph``, ``@type``
      arrays, etc.).
    - Title / ingredients / steps are all missing after mapping
      (minimum-validity fall-through).
    """
    if not html or not html.strip():
        return None
    if len(html.encode("utf-8", errors="ignore")) > _MAX_HTML_BYTES:
        logger.warning(
            "jsonld_parser skipped: html too large (> %d bytes)",
            _MAX_HTML_BYTES,
        )
        return None

    recipe = _find_recipe_in_html(html)
    if recipe is None:
        return None

    return _map_recipe_to_llm_output(recipe)


def _find_recipe_in_html(html: str) -> dict[str, Any] | None:
    """Return the first schema.org Recipe dict, or ``None``.

    Walks every ``<script type="application/ld+json">`` block in order
    and enforces the :data:`_MAX_JSONLD_BLOCK_BYTES` cap per block so a
    single oversized (possibly hostile) payload can't block smaller
    in-budget blocks on the same page from getting a chance. Each
    in-budget block is parsed defensively (malformed JSON -> skip) and
    walked for a Recipe entity (including inside ``@graph`` arrays and
    ``@type``-array forms).

    When every block is malformed / oversize / Recipe-less, the
    function falls through to :func:`extract_jsonld` from
    :mod:`extractor.pipeline.blog` as a last-resort safety net -- that
    helper uses ``extruct``, which is more lenient about oddly-formatted
    or cdata-wrapped JSON-LD than stdlib ``json.loads``. This branch has
    NO block size check because the bounded 5 MiB whole-HTML cap above
    already limits the worst-case memory burst, and the fallback is the
    only way to recover a valid Recipe from a page whose JSON-LD is
    slightly non-standard.
    """
    # Primary -- manual regex + json.loads with per-block size cap.
    # Keeps the attacker-DoS guard enforceable (extruct doesn't expose a
    # per-block budget) while still handling the common ``@graph`` +
    # ``@type``-array cases via :func:`_find_recipe_in_obj`.
    any_script_block_seen = False
    for match in _JSONLD_BLOCK_RE.finditer(html):
        any_script_block_seen = True
        block = match.group(1)
        if len(block.encode("utf-8", errors="ignore")) > _MAX_JSONLD_BLOCK_BYTES:
            logger.info(
                "jsonld_parser skipped block: > %d bytes",
                _MAX_JSONLD_BLOCK_BYTES,
            )
            continue
        try:
            data = json.loads(block)
        except (json.JSONDecodeError, ValueError):
            # Malformed JSON -- skip, try the next block.
            continue
        recipe = _find_recipe_in_obj(data)
        if recipe is not None:
            return recipe

    # Fallback -- extruct is more lenient on odd JSON-LD formatting
    # (cdata wrappers, trailing commas some hand-rolled sites ship).
    # Only invoked when the regex path saw at least one <script> block
    # but couldn't produce a Recipe -- otherwise there's nothing for
    # extruct to find either.
    if not any_script_block_seen:
        return None
    try:
        return extract_jsonld(html)
    except Exception:  # pragma: no cover -- defensive; extract_jsonld already wraps
        return None


def _find_recipe_in_obj(obj: Any) -> dict[str, Any] | None:
    """Walk a parsed JSON-LD object/array and return the first Recipe dict."""
    if isinstance(obj, dict):
        if _is_recipe_type(obj.get("@type")):
            return obj
        # @graph: standard schema.org container for multi-entity payloads.
        graph = obj.get("@graph")
        if isinstance(graph, list):
            for item in graph:
                found = _find_recipe_in_obj(item)
                if found is not None:
                    return found
        return None
    if isinstance(obj, list):
        for item in obj:
            found = _find_recipe_in_obj(item)
            if found is not None:
                return found
    return None


def _is_recipe_type(type_value: Any) -> bool:
    """Accept both ``"Recipe"`` string and ``[..., "Recipe", ...]`` list forms."""
    if isinstance(type_value, str):
        return type_value == "Recipe"
    if isinstance(type_value, list):
        return any(isinstance(v, str) and v == "Recipe" for v in type_value)
    return False


def _map_recipe_to_llm_output(recipe: dict[str, Any]) -> dict[str, Any] | None:
    """Map a schema.org Recipe dict to the ``llm_output`` shape.

    Returns ``None`` when the minimum-validity check fails: no title OR
    no ingredient lines OR no instruction steps. In that case the
    pipeline falls through to the LLM path so the user still gets a
    shot at a structured result.
    """
    name = recipe.get("name")
    title = name.strip() if isinstance(name, str) and name.strip() else None

    description_raw = recipe.get("description")
    description = (
        description_raw.strip()
        if isinstance(description_raw, str) and description_raw.strip()
        else None
    )

    raw_ingredients = recipe.get("recipeIngredient") or recipe.get("ingredients") or []
    ingredients_payload: list[dict[str, Any]] = []
    if isinstance(raw_ingredients, list):
        for line in raw_ingredients:
            if len(ingredients_payload) >= _MAX_INGREDIENTS_PER_RECIPE:
                # Hostile / bloated JSON-LD -- hard-cap so a malicious
                # blog can't flood the DB with 10k ingredient rows.
                logger.info(
                    "jsonld_parser capped ingredients at %d",
                    _MAX_INGREDIENTS_PER_RECIPE,
                )
                break
            if not isinstance(line, str):
                continue
            parsed = parse_ingredient_line(line)
            # Drop empty-name lines -- they'd fail the post_process gate
            # anyway and only clutter the candidate output.
            if not parsed["name"].strip():
                continue
            ingredients_payload.append(
                {
                    "name": parsed["name"],
                    "quantity": parsed["quantity"],
                    "unit": parsed["unit"],
                    # ``note`` carries the raw source line for audit /
                    # manual correction -- post_process caps at 500 chars.
                    "note": parsed["raw"] if parsed["raw"] != parsed["name"] else None,
                    "confidence": "high",
                }
            )

    instruction_lines = _flatten_instructions_to_list(recipe.get("recipeInstructions"))
    # Hard-cap steps -- same reasoning as the ingredient cap above.
    if len(instruction_lines) > _MAX_STEPS_PER_RECIPE:
        logger.info("jsonld_parser capped steps at %d", _MAX_STEPS_PER_RECIPE)
        instruction_lines = instruction_lines[:_MAX_STEPS_PER_RECIPE]
    steps_payload: list[dict[str, Any]] = []
    for index, line in enumerate(instruction_lines, start=1):
        steps_payload.append(
            {
                "position": index,
                "content": line,
                "confidence": "high",
            }
        )

    # Minimum-validity -- the pre-LLM branch is only worth taking when
    # all three pillars are present. Otherwise fall through to the LLM.
    if title is None or not ingredients_payload or not steps_payload:
        return None

    servings = parse_servings(recipe.get("recipeYield"))
    prep_minutes = iso_duration_to_minutes(_coerce_str(recipe.get("prepTime")))
    cook_minutes = iso_duration_to_minutes(_coerce_str(recipe.get("cookTime")))

    tags = _parse_tags(recipe)
    nutrition = _parse_nutrition(recipe.get("nutrition"))

    component: dict[str, Any] = {
        "label": None,
        "position": 0,
        "ingredients": ingredients_payload,
        "steps": steps_payload,
    }

    return {
        "title": title,
        "description": description,
        "servings": servings,
        "difficulty": None,  # schema.org has no difficulty equivalent
        "prep_minutes": prep_minutes,
        "cook_minutes": cook_minutes,
        "components": [component],
        "tags": tags,
        # source_url is overwritten by post_process with the caller-
        # supplied original URL. Placeholder is never persisted.
        "source_url": "",
        "nutrition_estimate": nutrition,
    }


def _coerce_str(value: Any) -> str | None:
    """Return ``value`` if it's a string, else ``None``."""
    return value if isinstance(value, str) else None


__all__ = [
    "IngredientLineParse",
    "extract_recipe_from_html",
    "iso_duration_to_minutes",
    "parse_ingredient_line",
    "parse_servings",
]
