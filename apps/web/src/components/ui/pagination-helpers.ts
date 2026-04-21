/**
 * Pagination helpers — split out of `./pagination.tsx` so the React
 * component file only re-exports components (satisfies the
 * `react-refresh/only-export-components` lint rule).
 */

/**
 * Build the numbered-page list for the desktop/tablet layout. Shows up
 * to 7 slots: current, two neighbours either side, first + last with
 * ellipses when needed. Mirrors the shadcn example at
 * https://ui.shadcn.com/docs/components/pagination.
 *
 * For small totals (≤ 7) all pages are listed explicitly. For bigger
 * ones the shape is one of:
 *   - `1 2 3 4 5 … N`      (current near the start)
 *   - `1 … k-1 k k+1 … N`  (current in the middle)
 *   - `1 … N-4 N-3 N-2 N-1 N` (current near the end)
 */
export function buildPageList(
  page: number,
  totalPages: number,
): Array<number | 'ellipsis'> {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1)
  }
  if (page <= 4) {
    return [1, 2, 3, 4, 5, 'ellipsis', totalPages]
  }
  if (page >= totalPages - 3) {
    return [
      1,
      'ellipsis',
      totalPages - 4,
      totalPages - 3,
      totalPages - 2,
      totalPages - 1,
      totalPages,
    ]
  }
  return [1, 'ellipsis', page - 1, page, page + 1, 'ellipsis', totalPages]
}
