"""Typed response shapes for the URL-extraction pipeline.

These ``TypedDict`` classes double as the wire contract for
``POST /extract/url``. The FastAPI endpoint mirrors them in a pydantic
model so request/response validation runs at the HTTP edge, but the
TypedDicts live here because the pipeline code is what produces them —
the HTTP layer is a thin translator.

Rules:
- Every field that can legitimately be absent is ``X | None`` (explicit
  ``None``) rather than ``NotRequired[X]``. The frontend renders both
  the same way, but an explicit ``None`` in the payload is easier to
  grep for in bug reports than a silently-missing key.
- Ingredients have their own confidence literal with ``"missing"``
  because post-processing flags quantity-less ingredients distinctly
  from low-confidence LLM guesses.
- Steps and the overall result use the three-level ``ConfidenceLevel``
  literal.
"""

from __future__ import annotations

from typing import Final, Literal, TypedDict, get_args

ConfidenceLevel = Literal["high", "medium", "low"]
"""Generic confidence classification — used for step-level + overall."""

IngredientConfidenceLevel = Literal["high", "medium", "low", "missing"]
"""Ingredient-specific confidence: adds ``missing`` for quantity-less items.

Post-processing flags every ingredient without a quantity as ``missing``
so the frontend highlights them for manual review. Distinct from
``low`` which means "LLM produced a value but is not sure".
"""

# Runtime-accessible tuples for tests and iteration. Drift-guarded by
# pairs of tests that pin them to ``get_args`` of the literals.
CONFIDENCE_LEVELS: Final[tuple[ConfidenceLevel, ...]] = get_args(ConfidenceLevel)
INGREDIENT_CONFIDENCE_LEVELS: Final[tuple[IngredientConfidenceLevel, ...]] = get_args(
    IngredientConfidenceLevel
)


class ExtractedIngredient(TypedDict):
    """One ingredient line from the recipe.

    - ``name`` is always present and non-empty (enforced by the LLM
      schema + post-process sanity check).
    - ``quantity`` / ``unit`` / ``note`` are ``None`` when unknown.
    - ``confidence`` defaults to ``"high"`` when the LLM emits a full
      line; post-processing downgrades to ``"missing"`` when ``quantity``
      is ``None``.
    """

    name: str
    quantity: str | None
    unit: str | None
    note: str | None
    confidence: IngredientConfidenceLevel


class ExtractedStep(TypedDict):
    """One preparation step.

    - ``position`` is 1-indexed (PRD §5.1). The frontend renders it verbatim.
    - ``content`` is the step's plain-text instruction.
    - ``confidence`` is ``"high"`` unless the step is paraphrased from a
      low-quality transcript; the LLM picks.
    """

    position: int
    content: str
    confidence: ConfidenceLevel


class ExtractedRecipe(TypedDict):
    """The structured recipe payload.

    Matches PRD §5.1 and the plan response shape 1:1. ``None`` on the
    optional scalar fields means "unknown / not stated in the source";
    the frontend renders a placeholder rather than guessing.
    """

    title: str
    description: str | None
    servings: int | None
    difficulty: int | None
    prep_minutes: int | None
    cook_minutes: int | None
    ingredients: list[ExtractedIngredient]
    steps: list[ExtractedStep]
    tags: list[str]
    source_url: str
    thumbnail_url: str | None


class ExtractionConfidence(TypedDict):
    """Per-request confidence metadata.

    - ``overall`` aggregates the ingredient + step confidences into a
      single badge the frontend can render prominently.
    - ``notes`` are free-form German-language strings for the reviewer
      (e.g. ``"Website nicht erreichbar"``, ``"Kein Rezept eindeutig
      erkennbar"``). Empty list when all is well.
    """

    overall: ConfidenceLevel
    notes: list[str]


class ExtractionResult(TypedDict):
    """Top-level response body for ``POST /extract/url``."""

    recipe: ExtractedRecipe
    confidence: ExtractionConfidence


__all__ = [
    "CONFIDENCE_LEVELS",
    "INGREDIENT_CONFIDENCE_LEVELS",
    "ConfidenceLevel",
    "ExtractedIngredient",
    "ExtractedRecipe",
    "ExtractedStep",
    "ExtractionConfidence",
    "ExtractionResult",
    "IngredientConfidenceLevel",
]
