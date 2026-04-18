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

from typing import Any

from extractor.pipeline.types import (
    ConfidenceLevel,
    ExtractedIngredient,
    ExtractedRecipe,
    ExtractedStep,
    ExtractionConfidence,
    ExtractionResult,
    IngredientConfidenceLevel,
)

_SERVINGS_MIN: int = 1
_SERVINGS_MAX: int = 20


def post_process(
    llm_output: dict[str, Any],
    *,
    original_url: str,
    fallback_thumbnail: str | None,
    extra_notes: list[str] | None = None,
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

    recipe: ExtractedRecipe = {
        "title": str(llm_output.get("title") or "Unbenanntes Rezept"),
        "description": _optional_str(llm_output.get("description")),
        "servings": servings,
        "difficulty": _optional_int(llm_output.get("difficulty")),
        "prep_minutes": _optional_int(llm_output.get("prep_minutes")),
        "cook_minutes": _optional_int(llm_output.get("cook_minutes")),
        "ingredients": ingredients,
        "steps": steps,
        "tags": tags,
        "source_url": original_url,
        "thumbnail_url": thumbnail_url,
    }

    notes: list[str] = list(extra_notes) if extra_notes else []
    confidence: ExtractionConfidence = {
        "overall": _aggregate_confidence(ingredients, steps),
        "notes": notes,
    }

    return {"recipe": recipe, "confidence": confidence}


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
    note = _optional_str(raw.get("note"))
    raw_confidence = raw.get("confidence")
    confidence: IngredientConfidenceLevel
    if quantity is None:
        # The plan: empty-quantity items always get ``missing`` regardless
        # of what the LLM claimed.
        confidence = "missing"
    elif raw_confidence in ("high", "medium", "low", "missing"):
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
    """Build an :class:`ExtractedStep`; drop malformed rows."""
    position = raw.get("position")
    content = raw.get("content")
    confidence_raw = raw.get("confidence")
    if not isinstance(position, int) or isinstance(position, bool) or position < 1:
        return None
    if not isinstance(content, str) or not content.strip():
        return None
    if confidence_raw not in ("high", "medium", "low"):
        return None
    return {
        "position": position,
        "content": content.strip(),
        "confidence": confidence_raw,
    }


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
    - If any step or ingredient is ``"low"`` → ``"medium"``.
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

    has_low = any(i["confidence"] == "low" for i in ingredients) or any(
        s["confidence"] == "low" for s in steps
    )
    if has_low:
        return "medium"

    return "high"


__all__ = ["post_process"]
