import { arrayMove } from '@dnd-kit/sortable'
import type { MealPlanSlotDto, MealSlot } from '@shared-cookbook/shared'

/**
 * Prefix for synthetic droppable IDs we attach to empty `(date, meal)`
 * cells so dnd-kit can target them as drop zones. The format is
 * `cell-<date>__<meal>`; the double-underscore separator is chosen so
 * neither the ISO date (`yyyy-mm-dd`) nor the German meal label
 * (`Frühstück`) collides with it.
 */
export const CELL_DROPPABLE_PREFIX = 'cell-'

const CELL_SEPARATOR = '__'

/**
 * Builds the droppable ID for an empty `(date, meal)` cell. Inverse of
 * {@link parseCellId}.
 */
export function buildCellId(date: string, meal: MealSlot): string {
  return `${CELL_DROPPABLE_PREFIX}${date}${CELL_SEPARATOR}${meal}`
}

/**
 * Returns `(date, meal)` extracted from a `cell-<date>__<meal>` ID, or
 * `null` if the input doesn't carry the cell-droppable prefix.
 */
export function parseCellId(
  id: string,
): { date: string; meal: MealSlot } | null {
  if (!id.startsWith(CELL_DROPPABLE_PREFIX)) return null
  const rest = id.slice(CELL_DROPPABLE_PREFIX.length)
  const sep = rest.indexOf(CELL_SEPARATOR)
  if (sep < 0) return null
  const date = rest.slice(0, sep)
  const meal = rest.slice(sep + CELL_SEPARATOR.length) as MealSlot
  return { date, meal }
}

/**
 * Distinguishes the two outcomes of a drag in the meal-plan grid:
 *
 * - `same-cell`: the slot ended up in the same `(date, meal)` bucket
 *   it started in; the consumer ships PATCH(es) bumping `sortOrder` only
 *   (existing reorder path).
 * - `cross-cell`: the slot moved into a different `(date, meal)` bucket;
 *   the consumer ships ONE PATCH carrying `{ date, meal, sortOrder }`.
 */
export type DragEndResolution =
  | {
      kind: 'same-cell'
      date: string
      meal: MealSlot
      orderedSlotIds: string[]
    }
  | {
      kind: 'cross-cell'
      slotId: string
      date: string
      meal: MealSlot
      sortOrder: number
    }

/**
 * Pure helper that translates a `DragEndEvent` (active + over IDs) plus
 * the current slot list into one of the two `DragEndResolution`s. Lives
 * outside the component so the logic is unit-testable without a full
 * render. Returns `null` when the drag should be a no-op (no over,
 * dropped on itself, unknown active slot).
 */
export function parseDragEnd({
  activeId,
  overId,
  slots,
}: {
  activeId: string
  overId: string | null
  slots: readonly MealPlanSlotDto[]
}): DragEndResolution | null {
  if (!overId || activeId === overId) return null
  const active = slots.find((s) => s.id === activeId)
  if (!active) return null

  // Empty-cell drop zone: synthetic ID encodes the target bucket.
  const cell = parseCellId(overId)
  if (cell) {
    if (cell.date === active.date && cell.meal === active.meal) {
      // Dropping on the empty-cell zone for the SAME bucket would just
      // be the active slot's own cell — no-op.
      return null
    }
    return {
      kind: 'cross-cell',
      slotId: activeId,
      date: cell.date,
      meal: cell.meal,
      sortOrder: 0,
    }
  }

  // Otherwise, the over target is another slot. Find it; its
  // (date, meal) is the target bucket.
  const over = slots.find((s) => s.id === overId)
  if (!over) return null

  if (over.date === active.date && over.meal === active.meal) {
    // Same-cell reorder — return the ordered IDs so the consumer can
    // run its existing index-based PATCH cascade.
    const cellSlots = slots
      .filter((s) => s.date === active.date && s.meal === active.meal)
      .sort(
        (a, b) =>
          a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt),
      )
    const ids = cellSlots.map((s) => s.id)
    const oldIndex = ids.indexOf(activeId)
    const newIndex = ids.indexOf(overId)
    if (oldIndex < 0 || newIndex < 0) return null
    return {
      kind: 'same-cell',
      date: active.date,
      meal: active.meal,
      orderedSlotIds: arrayMove(ids, oldIndex, newIndex),
    }
  }

  // Cross-cell: insert at the target slot's position.
  return {
    kind: 'cross-cell',
    slotId: activeId,
    date: over.date,
    meal: over.meal,
    sortOrder: over.sortOrder,
  }
}
