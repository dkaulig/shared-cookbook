/**
 * Shared portion-count bounds + clamp helper.
 *
 * Kitchen-practical range: you can't cook for zero people, and 99 is
 * already larger than any realistic family meal. Integers only —
 * fractional portions don't make sense at the stepper UI level; the
 * ingredient-scaling math downstream handles the non-integer quantities
 * that fall out of the ratio.
 *
 * Consumed by `PortionsPickerOverlay` (Cook-Now flow) and
 * `PortionStepperCard` (recipe detail page). Both used to carry a
 * byte-for-byte duplicate of this helper — the review bundle pulled it
 * into one place so future range tweaks don't drift.
 */
export const MIN_SERVINGS = 1
export const MAX_SERVINGS = 99

/**
 * Clamp a candidate portion count into `[MIN_SERVINGS, MAX_SERVINGS]`
 * and round to the nearest integer. `NaN` / `Infinity` collapse to
 * `MIN_SERVINGS` so a corrupted URL param or parse failure can't leave
 * the UI in a non-numeric state.
 */
export function clampPortions(value: number): number {
  if (!Number.isFinite(value)) return MIN_SERVINGS
  if (value < MIN_SERVINGS) return MIN_SERVINGS
  if (value > MAX_SERVINGS) return MAX_SERVINGS
  return Math.round(value)
}
