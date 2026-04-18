/**
 * Tiny date-based helper used by the Home page quick-filter chip row.
 *
 * The mockup (`docs/mockups/warme-kueche-home.html`) renders a
 * `Sommer-Abend` chip; we swap that label to `Winter-Abend` during the
 * November – February window so the chip feels appropriate year-round.
 * Keeping the rule explicit lives in its own file so the two places
 * that need the label (Home page + test) agree on the month buckets.
 */
export type SeasonalEveningLabel = 'Sommer-Abend' | 'Winter-Abend'

const WINTER_MONTHS = new Set<number>([10, 11, 0, 1]) // Nov, Dec, Jan, Feb

export function seasonalEveningLabel(now: Date = new Date()): SeasonalEveningLabel {
  return WINTER_MONTHS.has(now.getMonth()) ? 'Winter-Abend' : 'Sommer-Abend'
}
