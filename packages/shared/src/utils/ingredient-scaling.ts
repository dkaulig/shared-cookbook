/**
 * Ingredient scaling math for the Familien-Kochbuch portion slider
 * (PRD §4.5). Pure, side-effect-free: given a list of ingredients plus a
 * `from`/`to` serving count, returns a new list with quantities adjusted
 * proportionally, unit-aware rounding, and a pre-formatted
 * `displayQuantity` string ready for the UI.
 *
 * Design notes:
 *   - "Stück-family" units (Stück, Scheibe, Zehe, Blatt, Dose, Packung,
 *     Bund) must always round to whole numbers — "1.5 eggs" is absurd. We
 *     flag `wasRounded=true` whenever the unrounded value diverges from
 *     the rounded value by more than 0.05 so the UI can prefix "~".
 *   - Decimal units (g, ml, EL, TL, …) round to two decimals and strip
 *     trailing zeros: "1.5 TL" instead of "1.50 TL", "200 ml" instead of
 *     "200.00 ml".
 *   - Very small TL/EL values (< 0.125) fall back to "eine Prise" because
 *     sub-quarter-teaspoons are not practically measurable.
 *   - `scalable:false` OR `quantity:null` always pass through untouched.
 *     The "nach Geschmack" branch renders as exactly that German phrase.
 */

export type Unit =
  | 'g'
  | 'kg'
  | 'mg'
  | 'ml'
  | 'l'
  | 'cl'
  | 'dl'
  | 'EL'
  | 'TL'
  | 'Tasse'
  | 'Becher'
  | 'Prise'
  | 'Stück'
  | 'Scheibe'
  | 'Zehe'
  | 'Bund'
  | 'Blatt'
  | 'Dose'
  | 'Packung'
  | (string & {})

export interface ScalableIngredient {
  /** `null` renders as "nach Geschmack" and MUST be paired with `scalable:false`. */
  quantity: number | null
  unit: Unit
  name: string
  scalable: boolean
}

export interface ScaledIngredient extends ScalableIngredient {
  /** The quantity as entered in the recipe, unscaled. `null` for "nach Geschmack". */
  originalQuantity: number | null
  /**
   * True when the scaled quantity had to be rounded to a whole number for a
   * Stück-family unit AND the unrounded value diverged from the rounded
   * value by more than 0.05. The UI typically renders a leading "~" in
   * that case.
   */
  wasRounded: boolean
  /** Pre-formatted text ready to drop into the UI. */
  displayQuantity: string
}

/** Units for which scaling must always yield whole-number counts. */
export const STUECK_UNITS: readonly string[] = [
  'Stück',
  'Scheibe',
  'Zehe',
  'Blatt',
  'Dose',
  'Packung',
  'Bund',
]

/** Legacy/ASCII-only spellings we tolerate on input. Normalized to the canonical form. */
const UNIT_ALIASES: Readonly<Record<string, string>> = {
  Stueck: 'Stück',
  stueck: 'Stück',
  STUECK: 'Stück',
  Stuck: 'Stück',
}

const PRISE_THRESHOLD = 0.125
const ROUND_MARK_EPSILON = 0.05

function normalizeUnit(unit: string): string {
  return UNIT_ALIASES[unit] ?? unit
}

function isStueckUnit(unit: string): boolean {
  return STUECK_UNITS.includes(unit)
}

/**
 * Formats a number with up to two decimal places and strips trailing
 * zeros. Uses `.` as decimal separator because the existing test suite and
 * the PRD examples (§4.5: "1.5 TL", "0.25 l") match that.
 */
function formatDecimal(value: number): string {
  const rounded = Math.round(value * 100) / 100
  return rounded.toFixed(2).replace(/\.?0+$/, '')
}

/**
 * Scales a list of ingredients from `fromServings` to `toServings`,
 * respecting per-ingredient `scalable` flags and unit-aware rounding.
 */
export function scaleIngredients(
  ingredients: ScalableIngredient[],
  fromServings: number,
  toServings: number,
): ScaledIngredient[] {
  if (!(fromServings > 0)) {
    throw new Error('fromServings must be greater than zero.')
  }
  if (!(toServings > 0)) {
    throw new Error('toServings must be greater than zero.')
  }

  const factor = toServings / fromServings

  return ingredients.map((ing) => scaleSingle(ing, factor))
}

function scaleSingle(
  ing: ScalableIngredient,
  factor: number,
): ScaledIngredient {
  const canonicalUnit = normalizeUnit(ing.unit)

  // Pass-through: non-scalable entries OR "nach Geschmack" stay as-is.
  if (!ing.scalable || ing.quantity === null) {
    const displayQuantity =
      ing.quantity === null
        ? 'nach Geschmack'
        : formatDisplay(ing.quantity, canonicalUnit, false /* prise */, false)
    return {
      ...ing,
      unit: canonicalUnit,
      quantity: ing.quantity,
      originalQuantity: ing.quantity,
      wasRounded: false,
      displayQuantity,
    }
  }

  const raw = ing.quantity * factor

  if (isStueckUnit(canonicalUnit)) {
    const rounded = Math.max(1, Math.round(raw))
    const wasRounded = Math.abs(raw - rounded) > ROUND_MARK_EPSILON
    return {
      ...ing,
      unit: canonicalUnit,
      quantity: rounded,
      originalQuantity: ing.quantity,
      wasRounded,
      displayQuantity: formatStueckDisplay(rounded, canonicalUnit, wasRounded),
    }
  }

  // Decimal units.
  const rounded = Math.round(raw * 100) / 100
  const prise =
    (canonicalUnit === 'TL' || canonicalUnit === 'EL') && raw <= PRISE_THRESHOLD
  return {
    ...ing,
    unit: canonicalUnit,
    quantity: rounded,
    originalQuantity: ing.quantity,
    wasRounded: false,
    displayQuantity: formatDisplay(rounded, canonicalUnit, prise, false),
  }
}

function formatStueckDisplay(
  rounded: number,
  unit: string,
  wasRounded: boolean,
): string {
  const quantityText = formatDecimal(rounded)
  const prefix = wasRounded ? '~' : ''
  return `${prefix}${quantityText} ${unit}`
}

function formatDisplay(
  quantity: number,
  unit: string,
  prise: boolean,
  _stueckPending: boolean,
): string {
  if (prise) return 'eine Prise'
  const quantityText = formatDecimal(quantity)
  if (unit === '') return quantityText
  return `${quantityText} ${unit}`
}
