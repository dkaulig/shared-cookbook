"""Defensive post-processing on the LLM's structured response.

The LLM is constrained by the schema, but we still clean its output:

- Clamp ``servings`` to 1..20 (plan: even a large family rarely cooks
  for >20; over-sized values are usually LLM hallucination).
- Flag ``confidence="missing"`` on ingredients without a ``quantity``
  regardless of what the LLM claimed — the frontend highlights these
  for manual review.
- Lowercase + de-duplicate tags, drop empties.
- Pin ``source_url`` to the caller-supplied URL so the LLM can't redirect
  the user to a different page.
- Fall back to the caller-provided thumbnail (yt-dlp thumbnail or blog
  og:image) when the LLM didn't pick one.
- Compute an aggregate ``overall`` confidence from the per-item
  ingredient and step confidences.

Returns an :class:`ExtractionResult` ready to ship to the HTTP layer.
"""

from __future__ import annotations

import re
from difflib import SequenceMatcher
from typing import Any, Final

from extractor.llm.provider import TokenUsage
from extractor.pipeline.types import (
    ConfidenceLevel,
    EmptyReason,
    ExtractedIngredient,
    ExtractedRecipe,
    ExtractedStep,
    ExtractionConfidence,
    ExtractionResult,
    IngredientConfidenceLevel,
    NutritionEstimate,
    StepConfidenceLevel,
)

_SERVINGS_MIN: int = 1
_SERVINGS_MAX: int = 20

# BUG-030: imperial / English → metric / German translation table.
# Layer 2 defence-in-depth: the SYSTEM_PROMPT_DE already tells the LLM to
# convert imperial units to metric, but models occasionally leak an "oz"
# or "cup" through. This table lets _normalise_ingredient rewrite those
# free-text units on the way out so they match our German-metric UI.
#
# Each value is ``(target_unit, factor)`` where ``factor`` multiplies the
# quantity string (when it's numeric). For count-like units —
# ``clove → Zehe``, ``pinch → Prise``, ``piece → Stück`` — the factor is
# 1 because the count doesn't change; only the label translates.
# ``stick`` is the US butter-stick convention (~113 g) and becomes ``g``
# because the user will want to see the gram figure in the scaled UI.
_UNIT_TRANSLATIONS: Final[dict[str, tuple[str, float]]] = {
    # Mass
    "oz": ("g", 28.35),
    "ounce": ("g", 28.35),
    "ounces": ("g", 28.35),
    "lb": ("g", 453.6),
    "pound": ("g", 453.6),
    "pounds": ("g", 453.6),
    # Volume
    "cup": ("ml", 240),
    "cups": ("ml", 240),
    "tbsp": ("ml", 15),
    "tablespoon": ("ml", 15),
    "tablespoons": ("ml", 15),
    "tsp": ("ml", 5),
    "teaspoon": ("ml", 5),
    "teaspoons": ("ml", 5),
    "fl oz": ("ml", 29.57),
    "fl. oz.": ("ml", 29.57),
    "fluid ounce": ("ml", 29.57),
    # Count-like — factor 1, label only
    "clove": ("Zehe", 1),
    "cloves": ("Zehe", 1),
    "stick": ("g", 113),
    "sticks": ("g", 113),
    "pinch": ("Prise", 1),
    "pinches": ("Prise", 1),
    "slice": ("Scheibe", 1),
    "slices": ("Scheibe", 1),
    "bunch": ("Bund", 1),
    "bunches": ("Bund", 1),
    "piece": ("Stück", 1),
    "pieces": ("Stück", 1),
}


def _translate_unit(
    unit: str | None,
    quantity: str | None,
) -> tuple[str | None, str | None, bool]:
    """Normalise an English/imperial unit to German/metric.

    Returns a 3-tuple ``(new_unit, new_quantity, was_translated)``.

    - ``unit`` is matched case-insensitively after ``.strip()``; non-matches
      pass through unchanged with ``was_translated=False``.
    - ``quantity`` is multiplied by the conversion factor when the source
      is a numeric string (``"16"``, ``"0.5"``, ``"1,5"`` — both decimal
      separators tolerated) and rounded to the nearest integer for the
      whole-number UX our unit chips expect.
    - Non-numeric quantities (fractions like ``"1/2"``, freeform like
      ``"nach Geschmack"``) pass through verbatim; only the unit label
      translates. The prompt already asked the LLM to do the numeric
      conversion — post-process is a safety net, not a parser.
    - Count-like translations (clove → Zehe, pinch → Prise …) keep the
      quantity untouched because their factor is 1.

    The returned ``was_translated`` boolean is currently informational
    only; callers (``_normalise_ingredient``) ignore it. It's kept in the
    signature as a hook for future telemetry — e.g. counting how often
    the LLM still leaks imperial despite the prompt directive — without
    having to re-thread the function.
    """
    if unit is None:
        return unit, quantity, False
    key = unit.strip().lower()
    hit = _UNIT_TRANSLATIONS.get(key)
    if hit is None:
        return unit, quantity, False
    new_unit, factor = hit
    new_quantity = quantity
    if quantity and factor != 1:
        try:
            # Accept either decimal separator ("1.5" or "1,5"). LLM +
            # human free-text both show up in practice.
            n = float(quantity.replace(",", "."))
        except ValueError:
            # Non-numeric quantity (fractions, freeform) — leave as-is;
            # the prompt asked the LLM to convert, post-process just
            # unit-swaps.
            pass
        else:
            # ``round(..., 0)`` returns an int in Python 3 — the ``int``
            # cast is implicit. Store as str to match the schema shape.
            new_quantity = str(round(n * factor))
    return new_unit, new_quantity, True


# P2-10 nutrition clamp bounds. kcal > 5000/portion is almost always an
# LLM hallucination ("a bowl of butter"). Macros > 500 g/portion likewise —
# if the LLM emits those, we bound them in-range instead of dropping the
# whole field so at least the in-range fields survive.
_KCAL_MAX: int = 5000
_MACRO_MAX: int = 500
_NUTRITION_FIELDS: tuple[str, ...] = ("kcal", "protein_g", "carbs_g", "fat_g")


def post_process(
    llm_output: dict[str, Any],
    *,
    original_url: str,
    fallback_thumbnail: str | None,
    extra_notes: list[str] | None = None,
    usage: TokenUsage | None = None,
) -> ExtractionResult:
    """Apply the defensive rules and return an :class:`ExtractionResult`.

    Parameters
    ----------
    llm_output
        The parsed JSON the LLM returned. Already matches
        ``RECIPE_SCHEMA`` (Azure strict mode enforces); we still defend.
    original_url
        Caller-supplied URL — becomes ``recipe.source_url`` verbatim.
    fallback_thumbnail
        Used for ``recipe.thumbnail_url`` when the LLM didn't set one.
    extra_notes
        Optional extra strings to merge into ``confidence.notes``
        (e.g. ``"Website nicht erreichbar"``).
    usage
        :class:`TokenUsage` for the whole extraction. When provided
        it's attached to the returned
        :class:`ExtractionResult` so the HTTP layer can emit
        ``X-Extractor-*`` headers without a second round-trip
        through the pipeline.
    """
    raw_servings = llm_output.get("servings")
    servings = _clamp_servings(raw_servings)

    ingredients: list[ExtractedIngredient] = []
    for raw in llm_output.get("ingredients") or []:
        if not isinstance(raw, dict):
            continue
        ingredient = _normalise_ingredient(raw)
        if ingredient is not None:
            ingredients.append(ingredient)

    steps: list[ExtractedStep] = []
    for raw in llm_output.get("steps") or []:
        if not isinstance(raw, dict):
            continue
        step = _normalise_step(raw)
        if step is not None:
            steps.append(step)
    # Reviewer-mandated normalisation: positions must be 1..N in input
    # order even when the LLM returns gaps ([1, 3, 5]) or mis-ordered
    # values ([3, 1, 2]). The frontend uses `position` as a React key
    # and a display label; gaps produce missing "Schritt 2" headers and
    # duplicates collide in keyed lists. Input order is authoritative —
    # the LLM's position field is advisory only.
    for index, step in enumerate(steps, start=1):
        step["position"] = index

    tags = _normalise_tags(llm_output.get("tags") or [])

    llm_thumbnail = llm_output.get("thumbnail_url")
    thumbnail_url = (
        llm_thumbnail if isinstance(llm_thumbnail, str) and llm_thumbnail else fallback_thumbnail
    )

    nutrition_estimate = _normalise_nutrition_estimate(llm_output.get("nutrition_estimate"))

    # BUG-022 + BUG-028 — two defensive guards on the description field
    # plus the surrounding ingredients. The dedupe (BUG-022) runs first so
    # the mass-leak scan (BUG-028) never re-acts to a description that's
    # about to be dropped anyway.
    description = _normalise_description(_optional_str(llm_output.get("description")), steps)
    ingredients = _flag_mass_leak_in_description(description, ingredients)

    recipe: ExtractedRecipe = {
        "title": str(llm_output.get("title") or "Unbenanntes Rezept"),
        "description": description,
        "servings": servings,
        "difficulty": _optional_int(llm_output.get("difficulty")),
        "prep_minutes": _optional_int(llm_output.get("prep_minutes")),
        "cook_minutes": _optional_int(llm_output.get("cook_minutes")),
        "ingredients": ingredients,
        "steps": steps,
        "tags": tags,
        "source_url": original_url,
        "thumbnail_url": thumbnail_url,
        "nutrition_estimate": nutrition_estimate,
    }

    notes: list[str] = list(extra_notes) if extra_notes else []
    confidence: ExtractionConfidence = {
        "overall": _aggregate_confidence(ingredients, steps),
        "notes": notes,
    }

    # BUG-034 — empty-extraction quality gate. When the LLM returned
    # neither ingredients NOR steps the pipeline succeeded "nominally"
    # (no exception, the source was reachable, Azure answered) but the
    # result is not a recipe. We surface that as a dedicated flag so the
    # frontend can branch on it instead of rendering a silently-empty
    # form. ``empty_reason`` is ``"no_recipe_detected"`` here because we
    # only fire this gate after the pipeline got a full LLM response;
    # ``"empty_transcript"`` / ``"extractor_error"`` are reserved for
    # pipeline-level gates (BUG-033 and future error-degradation paths)
    # that sit ABOVE post-process.
    recipe_empty: bool = len(ingredients) == 0 and len(steps) == 0
    empty_reason: EmptyReason | None = "no_recipe_detected" if recipe_empty else None

    result: ExtractionResult = {
        "recipe": recipe,
        "confidence": confidence,
        "recipe_empty": recipe_empty,
        "empty_reason": empty_reason,
    }
    if usage is not None:
        result["usage"] = usage
    return result


# ─────────────────────────────────────────────────────────────────────
# helpers
# ─────────────────────────────────────────────────────────────────────


def _clamp_servings(raw: Any) -> int | None:
    """Keep ``None`` as ``None``; clamp ints to [1, 20]; anything else → None."""
    if raw is None:
        return None
    if not isinstance(raw, int) or isinstance(raw, bool):
        return None
    return max(_SERVINGS_MIN, min(_SERVINGS_MAX, raw))


def _optional_str(raw: Any) -> str | None:
    if raw is None:
        return None
    if isinstance(raw, str):
        stripped = raw.strip()
        return stripped or None
    return None


def _optional_int(raw: Any) -> int | None:
    if raw is None:
        return None
    if isinstance(raw, int) and not isinstance(raw, bool):
        return raw
    return None


def _normalise_ingredient(raw: dict[str, Any]) -> ExtractedIngredient | None:
    """Build an :class:`ExtractedIngredient`, flagging missing quantities.

    Returns ``None`` for rows without a valid ``name`` — those are
    LLM noise we drop silently.
    """
    name = raw.get("name")
    if not isinstance(name, str) or not name.strip():
        return None
    quantity = _optional_str(raw.get("quantity"))
    unit = _optional_str(raw.get("unit"))
    # BUG-030: rewrite imperial / English units (oz, cup, tbsp, clove …)
    # to metric / German (g, ml, Zehe …) as a safety net when the LLM
    # leaks an imperial string despite the SYSTEM_PROMPT_DE directive.
    # The helper leaves quantity/unit untouched for unknown units and
    # for non-numeric quantities (fractions, "nach Geschmack").
    unit, quantity, _translated = _translate_unit(unit, quantity)
    note = _optional_str(raw.get("note"))
    raw_confidence = raw.get("confidence")
    confidence: IngredientConfidenceLevel
    if quantity is None:
        # The plan: empty-quantity items always get ``missing`` regardless
        # of what the LLM claimed. A photo-path ingredient whose
        # handwriting is legible but whose quantity is still blank
        # surfaces as ``missing`` so the review UI can prompt for
        # manual entry.
        confidence = "missing"
    elif raw_confidence in (
        "high",
        "medium",
        "low",
        "missing",
        "handwritten_uncertain",
    ):
        confidence = raw_confidence
    else:
        confidence = "low"
    return {
        "name": name.strip(),
        "quantity": quantity,
        "unit": unit,
        "note": note,
        "confidence": confidence,
    }


def _normalise_step(raw: dict[str, Any]) -> ExtractedStep | None:
    """Build an :class:`ExtractedStep`; drop malformed rows.

    Accepts the three canonical confidence levels *and* the photo-path
    ``"handwritten_uncertain"`` literal so the Vision-LLM can flag
    barely-legible handwritten steps without being silently downgraded.
    """
    position = raw.get("position")
    content = raw.get("content")
    confidence_raw = raw.get("confidence")
    if not isinstance(position, int) or isinstance(position, bool) or position < 1:
        return None
    if not isinstance(content, str) or not content.strip():
        return None
    if confidence_raw not in ("high", "medium", "low", "handwritten_uncertain"):
        return None
    confidence: StepConfidenceLevel = confidence_raw
    return {
        "position": position,
        "content": content.strip(),
        "confidence": confidence,
    }


def _normalise_nutrition_estimate(raw: Any) -> NutritionEstimate | None:
    """Clamp the four nutrition fields or drop the whole object.

    Rules:
    - Not a dict (``None``, string, int, list…) → ``None``.
    - Missing any of the four required fields → ``None`` (the LLM didn't
      fill it coherently; half-a-measurement is worse than nothing).
    - Non-integer (or ``bool``, which Python treats as ``int``) field →
      ``None`` (garbage; drop everything rather than coerce).
    - In-range / out-of-range ints → clamped to the bounds:
      kcal 0..5000, macros 0..500. The bounds match the schema so a
      well-behaved LLM never gets its output rewritten.
    """
    if not isinstance(raw, dict):
        return None
    cleaned: dict[str, int] = {}
    for field in _NUTRITION_FIELDS:
        value = raw.get(field)
        if value is None:
            return None
        # ``bool`` is a subclass of ``int`` in Python — reject it explicitly
        # so a ``True`` doesn't silently become ``1`` kcal.
        if not isinstance(value, int) or isinstance(value, bool):
            return None
        upper = _KCAL_MAX if field == "kcal" else _MACRO_MAX
        cleaned[field] = max(0, min(upper, value))
    return {
        "kcal": cleaned["kcal"],
        "protein_g": cleaned["protein_g"],
        "carbs_g": cleaned["carbs_g"],
        "fat_g": cleaned["fat_g"],
    }


# BUG-022 dedupe + BUG-028 mass-leak guard. Both helpers are intentionally
# pure (no logging side-effects) so they're easy to unit-test in isolation.
# The similarity threshold is a tradeoff documented in the docstring.
_DESCRIPTION_DUPLICATE_THRESHOLD: float = 0.80
_MASS_PATTERN: re.Pattern[str] = re.compile(
    r"\d+\s*(?:g|kg|ml|l|EL|TL|Stück|Prise)\b",
    re.IGNORECASE,
)


def _normalise_description(description: str | None, steps: list[ExtractedStep]) -> str | None:
    """Drop description when it's substantially identical to steps[0].

    BUG-022. Vision-LLM on handwritten photo scans has a habit of
    populating ``description`` with the first step's text (to fulfil the
    required JSON field), then emitting the same text again in
    ``steps[0]``. Exact string equality is rare (the LLM rephrases
    slightly), so compare via :class:`difflib.SequenceMatcher` ratio;
    ≥ 0.80 similarity after simple normalisation (lower, strip, collapse
    whitespace) counts as duplicate. A short-circuit substring match
    catches the common "description ⊂ first step" case before the more
    expensive ratio computation.
    """
    if not description or not steps:
        return description
    first_step_text = steps[0]["content"]
    if not first_step_text:
        return description
    a = " ".join(description.lower().split())
    b = " ".join(first_step_text.lower().split())
    if not a or not b:
        return description
    # Short-circuit: exact-substring match in either direction
    # (description ⊂ step or step ⊂ description).
    if a in b or b in a:
        return None
    ratio = SequenceMatcher(None, a, b).ratio()
    if ratio >= _DESCRIPTION_DUPLICATE_THRESHOLD:
        return None
    return description


def _flag_mass_leak_in_description(
    description: str | None, ingredients: list[ExtractedIngredient]
) -> list[ExtractedIngredient]:
    """Downgrade confidence on shaky ingredients when ``description`` leaks a mass.

    BUG-028. If the LLM put a mass/volume token (``500 g``, ``3 EL``, …)
    into ``description`` AND there's at least one ingredient whose own
    quantity is ``None`` or already flagged uncertain, that's a strong
    signal the LLM mis-routed a quantity into the prose field. We do
    NOT attempt to auto-attach the leaked quantity (heuristic risk —
    "Variante a" from the backlog); we just downgrade the affected
    ingredients' confidence to ``"low"`` so the review UI surfaces them
    for manual correction.

    Note: the prompt instructs the LLM to use ``confidence="uncertain"``
    in this case, but that literal isn't part of the
    :data:`IngredientConfidenceLevel` enum (the closest validated
    levels are ``"low"`` and ``"handwritten_uncertain"``). For the
    URL-path the schema-valid downgrade is ``"low"`` — the same level
    ``_normalise_ingredient`` already coerces an unknown raw_confidence
    to.
    """
    if not description:
        return ingredients
    if not _MASS_PATTERN.search(description):
        return ingredients
    shaky = {None, "missing", "low", "handwritten_uncertain"}
    if not any(i["quantity"] is None or i["confidence"] in shaky for i in ingredients):
        return ingredients
    flagged: list[ExtractedIngredient] = []
    for ingredient in ingredients:
        if ingredient["quantity"] is None or ingredient["confidence"] in shaky:
            flagged.append({**ingredient, "confidence": "low"})
        else:
            flagged.append(ingredient)
    return flagged


def _normalise_tags(raw_tags: list[Any]) -> list[str]:
    """Lowercase + strip + dedupe (first-occurrence-wins)."""
    seen: set[str] = set()
    normalised: list[str] = []
    for tag in raw_tags:
        if not isinstance(tag, str):
            continue
        lowered = tag.strip().lower()
        if not lowered or lowered in seen:
            continue
        seen.add(lowered)
        normalised.append(lowered)
    return normalised


def _aggregate_confidence(
    ingredients: list[ExtractedIngredient],
    steps: list[ExtractedStep],
) -> ConfidenceLevel:
    """Roll the per-item confidences into a single overall level.

    Rules:
    - If nothing was extracted → ``"low"`` (no evidence).
    - If ``>= 50 %`` of the ingredients are ``"missing"`` → ``"low"``.
    - If any step or ingredient is ``"low"`` or
      ``"handwritten_uncertain"`` → ``"medium"`` (a handwritten
      uncertainty is a reviewer prompt, not a failure).
    - Else → ``"high"``.
    """
    total_ingredients = len(ingredients)
    total_steps = len(steps)
    if total_ingredients == 0 and total_steps == 0:
        return "low"

    missing_ratio = 0.0
    if total_ingredients:
        missing_count = sum(1 for i in ingredients if i["confidence"] == "missing")
        missing_ratio = missing_count / total_ingredients
    if missing_ratio >= 0.5:
        return "low"

    shaky = {"low", "handwritten_uncertain"}
    has_shaky = any(i["confidence"] in shaky for i in ingredients) or any(
        s["confidence"] in shaky for s in steps
    )
    if has_shaky:
        return "medium"

    return "high"


__all__ = ["post_process"]
