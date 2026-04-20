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
- The overall ``ExtractionConfidence`` level uses the three-value
  ``ConfidenceLevel`` literal. Steps use :data:`StepConfidenceLevel`
  which widens it with ``"handwritten_uncertain"`` for the photo path
  (P2-3).
"""

from __future__ import annotations

from typing import Final, Literal, NotRequired, TypedDict, get_args

from extractor.llm.provider import TokenUsage

ConfidenceLevel = Literal["high", "medium", "low"]
"""Aggregate confidence classification — used for the overall badge.

Stays at the three canonical levels because the frontend renders one
of three badge colours; the photo path's ``"handwritten_uncertain"``
literal is per-item, not aggregate.
"""

StepConfidenceLevel = Literal["high", "medium", "low", "handwritten_uncertain"]
"""Step-level confidence.

The base three levels plus ``"handwritten_uncertain"`` for the photo
path (P2-3). Printed / digital sources only ever use the first three;
the extra literal lets a handwritten step carry an explicit
"hard-to-read" flag distinct from a low-confidence guess.
"""

IngredientConfidenceLevel = Literal["high", "medium", "low", "missing", "handwritten_uncertain"]
"""Ingredient-specific confidence.

- ``"missing"`` — post-processing flag for quantity-less items.
- ``"handwritten_uncertain"`` — photo path (P2-3); the Vision-LLM
  could not read the handwriting confidently but still emitted a
  best-guess value.
"""

# Runtime-accessible tuples for tests and iteration. Drift-guarded by
# pairs of tests that pin them to ``get_args`` of the literals.
CONFIDENCE_LEVELS: Final[tuple[ConfidenceLevel, ...]] = get_args(ConfidenceLevel)
STEP_CONFIDENCE_LEVELS: Final[tuple[StepConfidenceLevel, ...]] = get_args(StepConfidenceLevel)
INGREDIENT_CONFIDENCE_LEVELS: Final[tuple[IngredientConfidenceLevel, ...]] = get_args(
    IngredientConfidenceLevel
)

EmptyReason = Literal["no_recipe_detected", "empty_transcript", "extractor_error"]
"""BUG-034 — why the extractor returned an empty recipe.

- ``no_recipe_detected`` — Azure analysed the sources and emitted zero
  ingredients AND zero steps; the caller fed a valid (non-blank)
  transcript / blog / caption but nothing recipe-shaped came back.
- ``empty_transcript`` — pipeline-layer gate (out of scope for BUG-034;
  BUG-033 wires this from ``url.py``): the caller had no audio to feed
  the LLM (silent / music-only video).
- ``extractor_error`` — post-analysis exception degraded to an empty
  result instead of propagating as a 500; kept in the enum so the UI
  can branch copy even though today's pipeline raises instead.

Kept as a runtime-accessible tuple (:data:`EMPTY_REASONS`) so tests and
future schema validators can iterate without manually mirroring the
literal.
"""

EMPTY_REASONS: Final[tuple[EmptyReason, ...]] = get_args(EmptyReason)


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
      low-quality transcript or handwritten source. The photo path
      (P2-3) may emit ``"handwritten_uncertain"`` for barely-legible
      rows; the URL path never does.
    """

    position: int
    content: str
    confidence: StepConfidenceLevel


class NutritionEstimate(TypedDict):
    """LLM-estimated per-portion nutrition (PRD §5.4, P2-10).

    All four fields are integers — the LLM rounds to whole numbers, and
    the post-processor clamps to sane ranges (kcal 0..5000, macros
    0..500 g) as defence against hallucinations.
    """

    kcal: int
    protein_g: int
    carbs_g: int
    fat_g: int


class ExtractedRecipe(TypedDict):
    """The structured recipe payload.

    Matches PRD §5.1 and the plan response shape 1:1. ``None`` on the
    optional scalar fields means "unknown / not stated in the source";
    the frontend renders a placeholder rather than guessing.

    ``nutrition_estimate`` is the P2-10 addition. ``None`` means the LLM
    did not provide an estimate — the frontend hides the Nährwerte
    section entirely in that case.
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
    nutrition_estimate: NutritionEstimate | None


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
    """Top-level response body for ``POST /extract/url``.

    ``usage`` is optional on the wire (:class:`typing.NotRequired`)
    because not every code path produces a usage envelope — e.g. a
    failure before any LLM call never gets here, but a future cached-
    result path might return an :class:`ExtractionResult` without
    hitting the model at all. The .NET side treats a missing
    ``usage`` as "no data, leave columns NULL".

    ``usage`` carries the provider-reported :class:`TokenUsage` — the
    pipeline makes exactly one LLM call today so there's nothing to
    aggregate; if we ever chain multiple calls this field will be a
    sum.
    """

    recipe: ExtractedRecipe
    confidence: ExtractionConfidence
    usage: NotRequired[TokenUsage]
    # BUG-034 — empty-extraction quality gate. ``recipe_empty`` is True
    # when post-processing found ``len(ingredients) == 0 AND
    # len(steps) == 0``; ``empty_reason`` carries a machine-readable
    # classifier so the frontend can branch copy. Both fields are always
    # present on the wire (``recipe_empty=False`` + ``empty_reason=None``
    # on healthy extractions) so the .NET bridge's opaque JSON-string
    # forwarding stays symmetric with the TS mirror.
    recipe_empty: bool
    empty_reason: EmptyReason | None


__all__ = [
    "CONFIDENCE_LEVELS",
    "EMPTY_REASONS",
    "INGREDIENT_CONFIDENCE_LEVELS",
    "STEP_CONFIDENCE_LEVELS",
    "ConfidenceLevel",
    "EmptyReason",
    "ExtractedIngredient",
    "ExtractedRecipe",
    "ExtractedStep",
    "ExtractionConfidence",
    "ExtractionResult",
    "IngredientConfidenceLevel",
    "NutritionEstimate",
    "StepConfidenceLevel",
]
