import type {
  ExtractedRecipe,
  IngredientConfidenceLevel,
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
}

/** Form default when the source is silent on servings. */
const DEFAULT_SERVINGS = 4

/** Form difficulty default — mirrors the fresh-create seed. */
const DEFAULT_DIFFICULTY: 1 | 2 | 3 = 1

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

  return {
    title: r.title,
    description: r.description ?? '',
    defaultServings: r.servings ?? DEFAULT_SERVINGS,
    prepTimeMinutes: prepMinutes,
    difficulty: clampDifficulty(r.difficulty),
    sourceUrl: r.source_url,
    ingredients,
    steps,
  }
}
