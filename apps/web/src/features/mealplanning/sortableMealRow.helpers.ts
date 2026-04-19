/**
 * Pure helpers for `SortableMealRow`. Kept in a separate module so
 * the component file can be a single-export React file (satisfies
 * `react-refresh/only-export-components`).
 */

/**
 * Step between consecutive `sortOrder` values in a freshly reindexed
 * bucket. Picked at 10 (not 1) so later phases can insert a slot
 * between two neighbours without a global reindex: drop between 0
 * and 10 → `5`. P3-3 always reindexes the full bucket for simplicity,
 * but the spacing is in place.
 */
export const SORT_ORDER_STEP = 10

/**
 * Given the slot IDs in their current visual order and an active → over
 * swap, returns the new order. No-op inputs (same ids, ids not in the
 * list) return the original array so callers can cheaply detect
 * "nothing to do" via reference equality.
 */
export function computeReorder(
  currentIds: readonly string[],
  activeId: string,
  overId: string,
): readonly string[] {
  if (activeId === overId) return currentIds
  const oldIndex = currentIds.indexOf(activeId)
  const newIndex = currentIds.indexOf(overId)
  if (oldIndex < 0 || newIndex < 0) return currentIds
  const next = [...currentIds]
  const [moved] = next.splice(oldIndex, 1)
  if (moved === undefined) return currentIds
  next.splice(newIndex, 0, moved)
  return next
}
