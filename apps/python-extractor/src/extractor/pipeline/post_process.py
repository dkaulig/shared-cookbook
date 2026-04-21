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
    ConfigSnapshot,
    EmptyReason,
    ExtractedComponent,
    ExtractedIngredient,
    ExtractedRecipe,
    ExtractedStep,
    ExtractionConfidence,
    ExtractionResult,
    ExtractionSignals,
    IngredientConfidenceLevel,
    NutritionEstimate,
    StepConfidenceLevel,
)

# COMP-1 — hardcoded fallback for the component-label cap. CFG-1 moved
# the live value to the ``pipeline.component_label_max`` config key; the
# caller passes an override via :func:`post_process`'s
# ``component_label_max`` argument, which lands here on the module
# helpers' ``label_max=`` parameter. 50 chars mirrors the tag-name cap
# and the JSON schema's ``component.label.maxLength`` — keeping the
# three numbers aligned guards against drift.
COMPONENT_LABEL_MAX_DEFAULT: Final[int] = 50

# COMP-FIX — hardcoded fallback for the generic-label blacklist. CFG-1
# moved the live value to ``pipeline.generic_label_blacklist``. When the
# caller doesn't pass an override, this default applies so the prod
# pipeline keeps working with the admin-UI values and the test pipeline
# keeps working without touching config. Strings are compared
# case-insensitive after ``.strip()``; the set itself is internal and
# never renders, so no escaping / Unicode normalisation beyond lowercase
# is needed.
GENERIC_COMPONENT_LABEL_BLACKLIST_DEFAULT: Final[tuple[str, ...]] = (
    "hauptzutaten",
    "zutaten",
    "hauptgericht",
    "ingredients",
    "main",
    "main ingredients",
    "recipe",
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
    signals: ExtractionSignals | None = None,
    nutrition_enabled: bool = True,
    component_label_max: int = COMPONENT_LABEL_MAX_DEFAULT,
    generic_label_blacklist: list[str] | tuple[str, ...] | None = None,
    config_snapshot: ConfigSnapshot | None = None,
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
    signals
        BUG-034 — which source signals the URL pipeline observed. When
        ``None``, defaults to all-false (legacy callers / photo path /
        chat path don't collect URL-style signals). Drives the
        :data:`EmptyReason` classifier when the recipe is empty: all
        three flags false → ``no_usable_source``; any flag true →
        ``no_recipe_detected``.
    nutrition_enabled
        CFG-1 feature flag. When ``False``, the recipe's
        ``nutrition_estimate`` is null-ed out regardless of what Azure
        returned — the admin UI toggle for turning off nutrition
        estimation without touching the prompt.
    component_label_max
        CFG-1 — ``pipeline.component_label_max``. Overrides the 50-char
        default for per-component label length. Caller fetches from
        :class:`ExtractorConfig` and passes through.
    generic_label_blacklist
        CFG-1 — ``pipeline.generic_label_blacklist``. Replaces the
        default blacklist that null-outs single-component labels like
        "Hauptzutaten", "Ingredients", etc. Matched case-insensitive on
        the stripped label.
    config_snapshot
        CFG-1 — the snapshot of the active LLM config that produced
        ``llm_output``. Attached to the result verbatim so the .NET
        side persists it in ``ResultJson`` for reproducibility.
    """
    raw_servings = llm_output.get("servings")
    servings = _clamp_servings(raw_servings)

    # CFG-1 — the generic-label blacklist defaults to the hardcoded
    # tuple but the admin UI can override via
    # ``pipeline.generic_label_blacklist``. Normalise to a frozenset
    # once so the per-component check stays O(1).
    blacklist_source = (
        generic_label_blacklist
        if generic_label_blacklist is not None
        else GENERIC_COMPONENT_LABEL_BLACKLIST_DEFAULT
    )
    generic_label_set: frozenset[str] = frozenset(s.strip().lower() for s in blacklist_source)

    # COMP-1 — normalise the nested components array. The helper
    # - drops malformed entries,
    # - renumbers positions to [0, 1, 2, ...] in LLM-emitted position order,
    # - dedupes by trimmed label (first-position wins; nulls stay
    #   independent so two unlabelled sub-recipes survive),
    # - normalises each component's own ingredients + steps (incl. the
    #   per-component step-position renumbering that the pre-COMP-1
    #   code did globally),
    # - substitutes a single default ``{label: None, position: 0,
    #   ingredients: [], steps: []}`` when the LLM emitted zero so the
    #   .NET side's COMP-0 domain invariant (≥1 component per recipe)
    #   is satisfied.
    components = _normalise_components(
        llm_output.get("components"),
        label_max=component_label_max,
        generic_label_blacklist=generic_label_set,
    )

    # BUG-022 + BUG-028 — the description guards compare against the
    # first step's content and scan for mass leaks. Components scope
    # both: the pre-COMP-1 code used ``steps[0]`` / ``ingredients`` at
    # the top level. For COMP-1 we use the FIRST step across components
    # (in component order) as the "first step" analogue, and the flat
    # union of all components' ingredients for the mass-leak scan.
    all_steps = [step for c in components for step in c["steps"]]
    all_ingredients = [ing for c in components for ing in c["ingredients"]]
    description = _normalise_description(_optional_str(llm_output.get("description")), all_steps)
    # Mass-leak guard may downgrade confidence on ingredients in any
    # component. Re-distribute the flagged flat list back into the
    # component structure in input order.
    flagged = _flag_mass_leak_in_description(description, all_ingredients)
    components = _redistribute_ingredients(components, flagged)

    tags = _normalise_tags(llm_output.get("tags") or [])

    llm_thumbnail = llm_output.get("thumbnail_url")
    thumbnail_url = (
        llm_thumbnail if isinstance(llm_thumbnail, str) and llm_thumbnail else fallback_thumbnail
    )

    # CFG-1 — ``feature.nutrition_estimate_enabled`` kill-switch. When
    # off, force ``nutrition_estimate=None`` regardless of what Azure
    # emitted so the admin can disable the section UI-wide without
    # rewriting the prompt.
    if nutrition_enabled:
        nutrition_estimate = _normalise_nutrition_estimate(llm_output.get("nutrition_estimate"))
    else:
        nutrition_estimate = None

    recipe: ExtractedRecipe = {
        "title": str(llm_output.get("title") or "Unbenanntes Rezept"),
        "description": description,
        "servings": servings,
        "difficulty": _optional_int(llm_output.get("difficulty")),
        "prep_minutes": _optional_int(llm_output.get("prep_minutes")),
        "cook_minutes": _optional_int(llm_output.get("cook_minutes")),
        "components": components,
        "tags": tags,
        "source_url": original_url,
        "thumbnail_url": thumbnail_url,
        "nutrition_estimate": nutrition_estimate,
    }

    notes: list[str] = list(extra_notes) if extra_notes else []
    all_steps_after_flag = [step for c in components for step in c["steps"]]
    all_ingredients_after_flag = [ing for c in components for ing in c["ingredients"]]
    confidence: ExtractionConfidence = {
        "overall": _aggregate_confidence(all_ingredients_after_flag, all_steps_after_flag),
        "notes": notes,
    }

    # BUG-034 — empty-extraction quality gate. When the LLM returned
    # neither ingredients NOR steps the pipeline succeeded "nominally"
    # (no exception, the source was reachable, Azure answered) but the
    # result is not a recipe. We surface that as a dedicated flag so the
    # frontend can branch on it instead of rendering a silently-empty
    # form. The ``empty_reason`` classifier uses the caller-supplied
    # signal flags so the frontend can show variant copy:
    #
    # - all three signals false → ``no_usable_source`` (the pipeline
    #   had nothing to feed the LLM — no caption URL, no blog text, no
    #   transcript);
    # - any signal true → ``no_recipe_detected`` (sources were there,
    #   the LLM just couldn't extract a recipe).
    #
    # ``empty_transcript`` / ``extractor_error`` remain reserved for
    # pipeline-level gates ABOVE post-process.
    effective_signals: ExtractionSignals = (
        signals
        if signals is not None
        else {
            "had_caption_url": False,
            "had_blog_source": False,
            "had_transcript": False,
        }
    )
    # COMP-1: the gate fires when ALL components have 0 ingredients
    # AND 0 steps. The single-default (synthesised) component is empty
    # by construction, so a zero-recipe LLM output still lands in the
    # empty branch.
    recipe_empty: bool = all(
        len(c["ingredients"]) == 0 and len(c["steps"]) == 0 for c in components
    )
    empty_reason: EmptyReason | None
    if not recipe_empty:
        empty_reason = None
    elif any(
        (
            effective_signals["had_caption_url"],
            effective_signals["had_blog_source"],
            effective_signals["had_transcript"],
        )
    ):
        empty_reason = "no_recipe_detected"
    else:
        empty_reason = "no_usable_source"

    result: ExtractionResult = {
        "recipe": recipe,
        "confidence": confidence,
        "recipe_empty": recipe_empty,
        "empty_reason": empty_reason,
        "signals": effective_signals,
    }
    if usage is not None:
        result["usage"] = usage
    if config_snapshot is not None:
        result["config_snapshot"] = config_snapshot
    return result


# ─────────────────────────────────────────────────────────────────────
# helpers
# ─────────────────────────────────────────────────────────────────────


def _default_component() -> ExtractedComponent:
    """COMP-1 — the synthesised single-default component.

    Used when the LLM's payload has no ``components`` key or emits an
    empty list. Carries ``label=None`` so the frontend renders the
    detail page exactly as it did pre-COMP-1 (no component header).
    """
    return {
        "label": None,
        "position": 0,
        "ingredients": [],
        "steps": [],
    }


def _normalise_component_label(raw: Any, *, label_max: int) -> str | None:
    """Trim + length-cap a component label.

    - Non-strings and whitespace-only strings → ``None`` (the frontend
      uses ``None`` as the "suppress the header" sentinel).
    - Valid strings get ``.strip()``'d and hard-truncated to
      ``label_max`` chars (default 50, matches the tag-name cap).
      Truncation is a defensive guard against a hostile LLM emitting
      long free-form text; the JSON schema caps at the same length so
      well-behaved LLMs never get their output rewritten. CFG-1 wires
      the cap to ``pipeline.component_label_max``.
    """
    if not isinstance(raw, str):
        return None
    stripped = raw.strip()
    if not stripped:
        return None
    if len(stripped) > label_max:
        return stripped[:label_max]
    return stripped


def _normalise_components(
    raw_components: Any,
    *,
    label_max: int = COMPONENT_LABEL_MAX_DEFAULT,
    generic_label_blacklist: frozenset[str] = frozenset(GENERIC_COMPONENT_LABEL_BLACKLIST_DEFAULT),
) -> list[ExtractedComponent]:
    """Normalise the LLM's ``components`` array to a trustable shape.

    Rules (in order):

    1. Drop non-dict entries silently.
    2. Sort by emitted ``position`` (ties stable — preserves input
       order so the LLM's first emission wins).
    3. Dedupe entries with the same trimmed non-null label — keep the
       first, drop subsequent duplicates. ``label=None`` entries are
       NOT deduped because two unlabelled components represent two
       distinct sub-recipes.
    4. Normalise each component's ingredients + steps using the same
       helpers as the pre-COMP-1 flat code (drop malformed rows,
       flag missing quantities, renumber steps 1..N within the
       component).
    5. Renumber positions to a contiguous 0-based sequence so the
       backend can trust the ordering. Emitted-``position`` only
       informs the sort; the returned values are 0, 1, 2, ….
    6. Substitute a single default component when the result would
       otherwise be empty (invariant: ≥1 component on every recipe).
    """
    entries: list[tuple[int, dict[str, Any]]] = []
    if isinstance(raw_components, list):
        for raw in raw_components:
            if not isinstance(raw, dict):
                continue
            emitted_position = raw.get("position")
            # Non-int positions fall to the end (sorted-stable); a bool
            # masquerading as an int would slip through ``isinstance``
            # so reject it explicitly.
            if isinstance(emitted_position, int) and not isinstance(emitted_position, bool):
                sort_key = emitted_position
            else:
                sort_key = 10**9  # large sentinel → sorts last
            entries.append((sort_key, raw))

    entries.sort(key=lambda pair: pair[0])

    seen_labels: set[str] = set()
    normalised: list[ExtractedComponent] = []
    for _, raw in entries:
        label = _normalise_component_label(raw.get("label"), label_max=label_max)
        if label is not None:
            if label in seen_labels:
                # Duplicate label — drop the higher-position entry.
                continue
            seen_labels.add(label)

        ingredients: list[ExtractedIngredient] = []
        for raw_ing in raw.get("ingredients") or []:
            if not isinstance(raw_ing, dict):
                continue
            ingredient = _normalise_ingredient(raw_ing)
            if ingredient is not None:
                ingredients.append(ingredient)

        steps: list[ExtractedStep] = []
        for raw_step in raw.get("steps") or []:
            if not isinstance(raw_step, dict):
                continue
            step = _normalise_step(raw_step)
            if step is not None:
                steps.append(step)
        # Per-component step-position renumbering — same 1..N rule as
        # the pre-COMP-1 global pass, scoped to this component. The
        # frontend uses ``position`` as a React key + display label, so
        # gaps / dupes still bite even though each component has its
        # own list now.
        for index, step in enumerate(steps, start=1):
            step["position"] = index

        normalised.append(
            {
                "label": label,
                "position": len(normalised),
                "ingredients": ingredients,
                "steps": steps,
            }
        )

    if not normalised:
        normalised.append(_default_component())

    # COMP-FIX safeguard — when exactly one component is left AND its
    # label matches the generic-placeholder blacklist, rewrite the label
    # to ``None`` so the frontend suppresses the component header. The
    # hardened prompt already instructs the LLM to emit ``null`` in this
    # case, but drift happens and the UI contract (1 component + null
    # label = no header) is load-bearing. Intentionally scoped to the
    # single-component branch: a multi-component recipe where one block
    # happens to carry "Hauptzutaten" is a legitimate split and keeps
    # its label.
    if len(normalised) == 1:
        only = normalised[0]
        if only["label"] is not None and only["label"].strip().lower() in (generic_label_blacklist):
            only["label"] = None

    return normalised


def _redistribute_ingredients(
    components: list[ExtractedComponent],
    flagged: list[ExtractedIngredient],
) -> list[ExtractedComponent]:
    """Map the flat mass-leak-flagged ingredient list back onto components.

    :func:`_flag_mass_leak_in_description` operates on a flat ingredient
    list (it's a BUG-028 guard from the pre-COMP-1 era and we keep its
    signature). After it runs, we re-split the flat output along the
    component boundaries so each component carries its own (possibly
    downgraded) ingredients.

    Invariant: ``sum(len(c.ingredients) for c in components) == len(flagged)``.
    """
    out: list[ExtractedComponent] = []
    cursor = 0
    for component in components:
        count = len(component["ingredients"])
        out.append(
            {
                "label": component["label"],
                "position": component["position"],
                "ingredients": flagged[cursor : cursor + count],
                "steps": component["steps"],
            }
        )
        cursor += count
    return out


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
