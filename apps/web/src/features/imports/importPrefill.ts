import type {
  EmptyReason,
  ExtractedRecipe,
  ExtractionResult,
  ExtractionSignals,
  IngredientConfidenceLevel,
  NutritionEstimate,
  StepConfidenceLevel,
} from '@familien-kochbuch/shared'

/**
 * Output shape consumed by `RecipeFormPage` when prefilling from an
 * import result.
 *
 * Mirrors the fields the form owns as `useState`, so the form can seed
 * each piece directly from `ImportPrefill.*`. The per-row `confidence`
 * attachments live on the ingredient and step rows so the renderer can
 * show the "Menge fehlt" / "Handschrift prüfen" badges without
 * re-walking the raw ExtractionResult.
 */
export interface ImportPrefillIngredient {
  /** "" when missing — the form's IngredientRow stores the quantity as
   *  a string (the same editable shape a fresh row has). */
  quantity: string
  /** Falls back to "g" to match the form's default select. */
  unit: string
  name: string
  note: string
  /** Non-null quantity → scalable; missing quantity → auto-disabled. */
  scalable: boolean
  confidence: IngredientConfidenceLevel
}

export interface ImportPrefillStep {
  content: string
  confidence: StepConfidenceLevel
}

export interface ImportPrefill {
  title: string
  description: string
  defaultServings: number
  prepTimeMinutes: number | null
  difficulty: 1 | 2 | 3
  sourceUrl: string
  ingredients: ImportPrefillIngredient[]
  steps: ImportPrefillStep[]
  /**
   * True when the extractor reported the photo-pipeline sentinel as
   * `source_url`. The provenance banner branches on this to swap the
   * "AI-Vorschlag aus {url}" copy for "AI-Vorschlag aus deinen Fotos".
   * `sourceUrl` above is always emptied out when this flag is true so
   * the saved recipe doesn't carry the junk sentinel into the DB.
   */
  isPhotoImport: boolean
  /**
   * P2-10: optional per-portion nutrition estimate. `null` when the
   * LLM couldn't infer quantities. Flows through to the create-recipe
   * payload so the saved recipe carries the estimate from day one.
   */
  nutritionEstimate: NutritionEstimate | null
  /**
   * BUG-018 — id of a {@link StagedPhotoResponse.stagedPhotoId} the
   * URL-import job auto-created from the extracted video thumbnail.
   * Forwarded into the create-recipe staged-photo list so the user
   * sees the thumbnail attached on the saved recipe without lifting
   * a finger. `null` when the source had no thumbnail (typical for
   * blog imports) or the auto-download failed gracefully.
   *
   * Note this is *only* populated by the wrapper that has access to
   * the import status response; `extractedRecipeToPrefill` itself
   * doesn't see it (the {@link ExtractedRecipe} just carries the raw
   * `thumbnail_url` string, which the form intentionally ignores in
   * favour of the persisted SeaweedFS copy).
   */
  thumbnailStagedPhotoId: string | null
  /**
   * BUG-034 — true when the extractor gated the result as "no
   * recipe detected" (empty ingredients AND empty steps after
   * normalisation). The form wrapper branches on this to render
   * `EmptyExtractionExplainer` instead of the normal inner form.
   * Defaults to `false` for chat imports + legacy callers where the
   * field is missing on the parsed `ExtractionResult`.
   */
  recipeEmpty: boolean
  /**
   * BUG-034 — machine-readable reason so the explainer can pick German
   * copy. `null` iff `recipeEmpty === false`.
   */
  emptyReason: EmptyReason | null
  /**
   * BUG-034 (signal-aware follow-up) — which source signals the URL
   * pipeline actually observed. The explainer renders variant German
   * copy based on the flag state. Defaults to all-false for legacy /
   * chat-import payloads that pre-date the server field.
   */
  signals: ExtractionSignals
  /**
   * BUG-045 — raw AI-extracted tag names (lowercase German slugs, e.g.
   * `['vegetarisch', 'schnell']`). The form resolves them against the
   * group's tag catalogue by case-insensitive name match and pre-
   * selects the corresponding chips. Names that don't resolve to a
   * catalogue tag are silently dropped (the user can still add them
   * manually via "Neuen Tag erstellen"). Empty array when the
   * extractor found no tags.
   */
  tags: string[]
}

/** Form default when the source is silent on servings. */
const DEFAULT_SERVINGS = 4

/** Form difficulty default — mirrors the fresh-create seed. */
const DEFAULT_DIFFICULTY: 1 | 2 | 3 = 1

/**
 * Python pipeline emits this sentinel for the Photo pipeline because
 * there's no human-meaningful URL to anchor the recipe to. The frontend
 * must not persist it on the saved recipe (it would leak as a junk
 * "source" link in the UI) and the provenance banner needs different
 * copy than the URL-import case ("aus deinen Fotos" vs "aus {url}").
 * Kept exported for the banner + save-path shared detection.
 */
export const PHOTO_SOURCE_SENTINEL = 'photos://upload'

/** True if the extracted recipe's `source_url` is the photo sentinel. */
export function isPhotoImportSource(sourceUrl: string): boolean {
  return sourceUrl === PHOTO_SOURCE_SENTINEL
}

/** Maps the free-text "unit" the LLM might emit into the form's select
 *  options. Items not in this list stay as the raw LLM string; the
 *  select's onChange preserves whatever was passed in via `defaultValue`. */
const KNOWN_UNITS = new Set([
  'g',
  'kg',
  'ml',
  'l',
  'EL',
  'TL',
  'Stück',
  'Prise',
  'Bund',
  'Tasse',
  'Becher',
  'Scheibe',
  'Zehe',
  'nach Geschmack',
])

/** Normalise whatever unit string the extractor emitted. Missing or
 *  blank → "g" (the form's default). Strings that happen to match a
 *  known unit case-insensitively are canonicalised; unknown strings are
 *  preserved verbatim so the user can see what the AI produced. */
function normaliseUnit(raw: string | null | undefined): string {
  if (!raw) return 'g'
  const trimmed = raw.trim()
  if (trimmed === '') return 'g'
  // Direct hit.
  if (KNOWN_UNITS.has(trimmed)) return trimmed
  // Case-insensitive match.
  for (const known of KNOWN_UNITS) {
    if (known.toLowerCase() === trimmed.toLowerCase()) return known
  }
  return trimmed
}

/** Clamp a difficulty hint to the 1..3 scale the form expects. */
function clampDifficulty(raw: number | null | undefined): 1 | 2 | 3 {
  if (raw == null) return DEFAULT_DIFFICULTY
  if (raw <= 1) return 1
  if (raw >= 3) return 3
  return 2
}

/**
 * Convert the Python extractor's `ExtractedRecipe` into the shape the
 * form wants. Quantity comes through as a string deliberately — the
 * form stores ingredient quantities as strings so the user can edit
 * "1/2" or "nach Geschmack" without the form model trying to coerce
 * them to `number` every keystroke.
 *
 * `thumbnailStagedPhotoId` (BUG-018) is opaque to the recipe-shape
 * conversion — it lives on the `RecipeImportDto` envelope, not the
 * inner extracted recipe — so this function defaults it to `null`.
 * The wrapper that has the full DTO in scope is responsible for
 * overlaying it onto the prefill via {@link withImportEnvelope}.
 */
export function extractedRecipeToPrefill(r: ExtractedRecipe): ImportPrefill {
  const ingredients = r.ingredients.map((i): ImportPrefillIngredient => {
    const quantity = i.quantity?.trim() ?? ''
    // A missing quantity forces scalable off — the scaler throws on
    // null/0 and we don't want to surprise the user with a confusing
    // error when they click Save.
    const scalable = quantity !== ''
    return {
      quantity,
      unit: normaliseUnit(i.unit),
      name: i.name,
      note: i.note ?? '',
      scalable,
      confidence: i.confidence,
    }
  })

  const steps = r.steps.map((s): ImportPrefillStep => ({
    content: s.content,
    confidence: s.confidence,
  }))

  const prepMinutes =
    r.prep_minutes != null || r.cook_minutes != null
      ? (r.prep_minutes ?? 0) + (r.cook_minutes ?? 0)
      : null

  // Photo imports have no real source URL — the Python pipeline pins
  // the synthetic `photos://upload` sentinel to satisfy the required
  // ExtractedRecipe.source_url field. Strip it here so the form's
  // sourceUrl state defaults to "" and the saved recipe doesn't carry
  // the junk scheme into the DB. The `isPhotoImport` flag carries the
  // signal through to the provenance banner so it can render photo-
  // specific copy.
  const isPhotoImport = isPhotoImportSource(r.source_url)
  const sourceUrl = isPhotoImport ? '' : r.source_url

  // P2-10: map the Python snake_case nutrition estimate onto the
  // camelCase domain DTO. When the LLM returned `null` / omitted the
  // field, stays `null` — the form hides the preview section entirely.
  const ne = r.nutrition_estimate
  const nutritionEstimate: NutritionEstimate | null =
    ne == null
      ? null
      : {
          kcal: ne.kcal,
          proteinG: ne.protein_g,
          carbsG: ne.carbs_g,
          fatG: ne.fat_g,
        }

  return {
    title: r.title,
    description: r.description ?? '',
    defaultServings: r.servings ?? DEFAULT_SERVINGS,
    prepTimeMinutes: prepMinutes,
    difficulty: clampDifficulty(r.difficulty),
    sourceUrl,
    ingredients,
    steps,
    isPhotoImport,
    nutritionEstimate,
    // Caller (RecipeFormPage wrapper) overlays this from the import
    // DTO via `withImportEnvelope` — the bare extracted-recipe shape
    // doesn't carry it.
    thumbnailStagedPhotoId: null,
    // BUG-034 — the empty-gate fields live on the outer ExtractionResult,
    // not the inner ExtractedRecipe. The wrapper `extractedResultToPrefill`
    // (below) layers them on top. Bare-recipe callers get the
    // "not empty" default so they skip the explainer branch.
    recipeEmpty: false,
    emptyReason: null,
    // BUG-034 (signal-aware) — signals live on the outer envelope too;
    // `extractedResultToPrefill` overlays the real values. Bare-recipe
    // callers (chat imports) get an all-false default which is
    // consistent with the empty-gate skip above.
    signals: {
      had_caption_url: false,
      had_blog_source: false,
      had_transcript: false,
    },
    // BUG-045 — surface the AI-extracted tag names; `r.tags ?? []` so
    // older wire payloads (pre-tags field) don't crash the mapper.
    tags: r.tags ?? [],
  }
}

/**
 * BUG-034 — sibling of {@link extractedRecipeToPrefill} that also
 * carries the outer-envelope empty-gate fields through. Prefer this
 * when you have the full {@link ExtractionResult} (e.g. the polling
 * response from `GET /api/imports/:id`). Falls back gracefully when
 * the server omitted the fields — older Python builds or a bad
 * proxy — so the form never crashes on missing keys.
 */
export function extractedResultToPrefill(result: ExtractionResult): ImportPrefill {
  const prefill = extractedRecipeToPrefill(result.recipe)
  // Server payloads from before BUG-034 have neither field; treat the
  // missing values as "not empty" to preserve the pre-BUG-034 UX
  // (no explainer on legacy results).
  const recipeEmpty = result.recipe_empty ?? false
  const emptyReason = (result.empty_reason ?? null) as EmptyReason | null
  // BUG-034 (signal-aware) — server payloads from before the follow-up
  // have no `signals` field either. Default to all-false so the
  // `no_usable_source` copy applies (the honest answer: we don't know
  // which sources were captured).
  const signals: ExtractionSignals = result.signals ?? {
    had_caption_url: false,
    had_blog_source: false,
    had_transcript: false,
  }
  return { ...prefill, recipeEmpty, emptyReason, signals }
}

/**
 * BUG-018 — overlays the import-DTO-level fields onto a prefill the
 * form needs but `extractedRecipeToPrefill` can't see (it only gets
 * the inner recipe). Currently just propagates the auto-attached
 * thumbnail staged-photo id, but the seam is named generically so
 * future envelope-only fields (e.g. createdAt, attribution) can join
 * here without another shape rev.
 *
 * Returns a fresh object — never mutates the input. When
 * `thumbnailStagedPhotoId` is null/undefined the prefill comes back
 * unchanged.
 */
export function withImportEnvelope(
  prefill: ImportPrefill,
  envelope: { thumbnailStagedPhotoId?: string | null },
): ImportPrefill {
  if (!envelope.thumbnailStagedPhotoId) return prefill
  return { ...prefill, thumbnailStagedPhotoId: envelope.thumbnailStagedPhotoId }
}
