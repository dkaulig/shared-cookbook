import type { IngredientCategory } from '@familien-kochbuch/shared'

/**
 * German UI labels for the eleven `IngredientCategory` values. The
 * shared type uses ASCII-only identifiers so the .NET enum round-trips
 * cleanly (no umlauts on the wire); the frontend maps them back to the
 * rendered label at display time.
 *
 * `CATEGORY_ORDER` pins the section sequence so "Obst & Gemüse" is
 * always at the top of the shopping view (matches a typical
 * supermarket-walk layout) and "Sonstiges" is always last.
 */
export const CATEGORY_LABELS: Record<IngredientCategory, string> = {
  ObstGemuese: 'Obst & Gemüse',
  Trockenwaren: 'Trockenwaren',
  Gewuerze: 'Gewürze',
  Molkerei: 'Molkerei',
  FleischFisch: 'Fleisch & Fisch',
  BackenSuess: 'Backen & Süßes',
  KonservenFertig: 'Konserven & Fertiggerichte',
  GetraenkeOele: 'Getränke & Öle',
  TiefkuehlBrot: 'Tiefkühl & Brot',
  Haushalt: 'Haushalt',
  Sonstiges: 'Sonstiges',
}

/**
 * Display order of category sections in the grouped view. Deliberately
 * exported as a frozen readonly tuple so callers can rely on the
 * sequence without defensive copies, and `Object.keys(CATEGORY_LABELS)`
 * drift (insertion-order quirks) can't change the UI silently.
 */
export const CATEGORY_ORDER: readonly IngredientCategory[] = Object.freeze([
  'ObstGemuese',
  'Trockenwaren',
  'Gewuerze',
  'Molkerei',
  'FleischFisch',
  'BackenSuess',
  'KonservenFertig',
  'GetraenkeOele',
  'TiefkuehlBrot',
  'Haushalt',
  'Sonstiges',
])

/**
 * Every `IngredientCategory` in the same order as `CATEGORY_ORDER` —
 * convenience helper for forms that need to render a full category
 * dropdown (e.g. AddItemDialog).
 */
export const ALL_CATEGORIES: readonly IngredientCategory[] = CATEGORY_ORDER
