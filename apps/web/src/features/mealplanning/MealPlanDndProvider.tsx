import { useCallback } from 'react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import type { MealPlanSlotDto, MealSlot } from '@shared-cookbook/shared'
import { cn } from '@/lib/utils'
import { MEALPLAN_POINTER_ACTIVATION } from './SortableMealRow'
import { buildCellId, parseDragEnd } from './crossCellDrag'

/**
 * Page-level `<DndContext>` wrapper for the meal-plan grid. Owns the
 * sensors + collision-detection + drag-end logic so a single drag can
 * cross between `(date, meal)` cells. Each cell still mounts its own
 * `SortableContext` (via `<SortableMealRow>`) for in-cell reorder
 * semantics.
 *
 * The provider is generic over the layout — `MealPlanPage` mounts one
 * around the desktop grid, and `MobileDayStack` mounts one around the
 * mobile day-stack. Only one is ever in the tree at a time (layout
 * swap is React-conditional based on `useIsMobile()`), so there is
 * never an item-id collision between the two.
 *
 * Auto-scroll is on by default; the `<DndContext>` finds the nearest
 * scroll-ancestor automatically — the `<main>` element in MealPlanPage
 * for the desktop grid, the page-level scroller for the mobile stack.
 */
export function MealPlanDndProvider({
  slots,
  onSameCellReorder,
  onCrossCellMove,
  children,
}: {
  /** Current snapshot of all slots — used to map drag IDs to buckets. */
  slots: readonly MealPlanSlotDto[]
  /**
   * Called when the user drops a slot back into its own
   * `(date, meal)` bucket. Receives the bucket coordinates and the new
   * ordering so the consumer can ship one PATCH per moved row.
   */
  onSameCellReorder: (
    date: string,
    meal: MealSlot,
    orderedSlotIds: readonly string[],
  ) => void
  /**
   * Called when the user drops a slot into a different
   * `(date, meal)` bucket. The consumer ships ONE PATCH carrying
   * `{ date, meal, sortOrder }` to atomically express the move.
   */
  onCrossCellMove: (
    slotId: string,
    date: string,
    meal: MealSlot,
    sortOrder: number,
  ) => void
  children: React.ReactNode
}) {
  // PointerSensor activation tuned for mobile (see
  // `MEALPLAN_POINTER_ACTIVATION` for rationale: 200 ms hold + 5 px
  // movement before drag starts so quick taps still reach onClick).
  // KeyboardSensor keeps reorder accessible (Space → ArrowUp/Down).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: MEALPLAN_POINTER_ACTIVATION }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      const resolution = parseDragEnd({
        activeId: String(active.id),
        overId: over ? String(over.id) : null,
        slots,
      })
      if (!resolution) return
      if (resolution.kind === 'same-cell') {
        onSameCellReorder(
          resolution.date,
          resolution.meal,
          resolution.orderedSlotIds,
        )
      } else {
        onCrossCellMove(
          resolution.slotId,
          resolution.date,
          resolution.meal,
          resolution.sortOrder,
        )
      }
    },
    [slots, onSameCellReorder, onCrossCellMove],
  )

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
      autoScroll
    >
      {children}
    </DndContext>
  )
}

/**
 * Wraps an empty-cell render slot so dnd-kit recognises it as a drop
 * target. The synthetic ID is `cell-<date>__<meal>` (see
 * `buildCellId`); the visual highlight under hover (`bg-primary/5`)
 * makes it clear the empty cell can receive a drop.
 *
 * Children are rendered as-is; the wrapper is a single `<div>` that
 * inherits the cell's tap-area + relative positioning so the existing
 * "Noch keine Gerichte" button still fires `onClick` for empty-cell
 * tap-to-add.
 */
export function EmptyCellDrop({
  date,
  meal,
  className,
  children,
}: {
  date: string
  meal: MealSlot
  className?: string
  children: React.ReactNode
}) {
  const { isOver, setNodeRef } = useDroppable({ id: buildCellId(date, meal) })
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'rounded-md transition-colors',
        // Subtle primary tint matches the hover state on the empty-
        // cell button so the user sees the same affordance whether
        // they're tapping or dragging onto it.
        isOver && 'bg-primary/5 ring-1 ring-primary/30',
        className,
      )}
      data-testid={`mealplan-empty-cell-${date}-${meal}`}
    >
      {children}
    </div>
  )
}
