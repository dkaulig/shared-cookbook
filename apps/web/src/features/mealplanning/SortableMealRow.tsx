import { useEffect, useRef, useState } from 'react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { CheckCircle2, GripVertical, MoreHorizontal, Repeat } from 'lucide-react'
import type { MealPlanSlotDto } from '@familien-kochbuch/shared'
import { cn } from '@/lib/utils'

/**
 * Drag-reorder wrapper for all slots within a single (date, meal)
 * cell. Keeps the @dnd-kit wiring in one place so `MealPlanPage`
 * can stay focused on data fetching + top-level layout.
 *
 * We deliberately scope the DndContext **per cell** (not at the whole
 * page level) because cross-cell drag is out of scope for P3-3 —
 * the master plan defers moves between day/meal buckets to P3-10.
 * One DndContext per cell keeps the item-id space narrow and makes
 * it impossible to accidentally drop a Monday-Mittag slot into a
 * Tuesday-Abend cell today.
 *
 * The reorder scheme steps by `SORT_ORDER_STEP` (see `constants.ts`) so
 * later phases can insert a slot between two existing ones without
 * a global reindex. P3-3 always reindexes the full list of affected
 * rows for simplicity, but the spacing is in place.
 */
export function SortableMealRow({
  slots,
  onReorder,
  onEdit,
  onDelete,
  onToggleCooked,
  getParentLabel,
}: {
  slots: readonly MealPlanSlotDto[]
  /**
   * Called when the user drops a slot into a new position. Receives
   * the final ordered list of slot IDs (first = sortOrder 0, second =
   * sortOrder {@link SORT_ORDER_STEP}, etc.) — the parent translates
   * that into one or more PATCH calls.
   */
  onReorder: (orderedIds: readonly string[]) => void
  onEdit: (slot: MealPlanSlotDto) => void
  onDelete: (slot: MealPlanSlotDto) => void
  onToggleCooked: (slot: MealPlanSlotDto, nextCooked: boolean) => void
  /**
   * Resolves the short badge copy ("Mo Mittag") for a slot's parent.
   * Called only for slots whose `parentSlotId` is set + the parent
   * still exists in the plan. Returning `null` suppresses the badge
   * (happens when the parent has been deleted and the backend nulled
   * the child's `ParentSlotId` — the DTO lags one refetch).
   *
   * Optional so existing tests that render `SortableMealRow` without
   * the P3-4 wiring keep working; `MealPlanPage` always supplies it.
   */
  getParentLabel?: (slot: MealPlanSlotDto) => string | null
}) {
  // Mirror the RecipeFormPage sensor config so drag feels consistent
  // across the app + keyboard reorder (Space → ArrowUp/Down) keeps
  // working for non-mouse users.
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over) return
    const activeId = String(active.id)
    const overId = String(over.id)
    if (activeId === overId) return
    const ids = slots.map((s) => s.id)
    const oldIndex = ids.indexOf(activeId)
    const newIndex = ids.indexOf(overId)
    if (oldIndex < 0 || newIndex < 0) return
    onReorder(arrayMove(ids, oldIndex, newIndex))
  }

  if (slots.length === 0) return null

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext
        items={slots.map((s) => s.id)}
        strategy={verticalListSortingStrategy}
      >
        <ul className="space-y-1.5">
          {slots.map((slot) => (
            <li key={slot.id}>
              <SortableSlotCard
                slot={slot}
                parentLabel={getParentLabel?.(slot) ?? null}
                onEdit={() => onEdit(slot)}
                onDelete={() => onDelete(slot)}
                onToggleCooked={(next) => onToggleCooked(slot, next)}
              />
            </li>
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  )
}

/**
 * Single slot card with drag-handle, edit-on-click, cooked-checkbox,
 * and an overflow menu hosting the "Löschen" action. The card itself
 * is the click target for the edit flow — the drag handle intercepts
 * pointer events so dragging doesn't accidentally open the edit
 * dialog, and the menu + checkbox stop propagation for the same
 * reason.
 */
function SortableSlotCard({
  slot,
  parentLabel,
  onEdit,
  onDelete,
  onToggleCooked,
}: {
  slot: MealPlanSlotDto
  parentLabel: string | null
  onEdit: () => void
  onDelete: () => void
  onToggleCooked: (next: boolean) => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: slot.id })

  const title =
    slot.label?.trim() || (slot.recipeId ? 'Rezept' : 'Unbenanntes Gericht')
  const servingsLabel = slot.servings === 1 ? 'Portion' : 'Portionen'

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.8 : slot.isCooked ? 0.7 : 1,
  }

  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)

  // Close the menu on outside-click / Escape — small, self-contained
  // replacement for a full DropdownMenu primitive (not yet available
  // in our shadcn set). The listener is registered only while the
  // menu is open to avoid work on every other card.
  useEffect(() => {
    if (!menuOpen) return
    function handleDown(e: MouseEvent) {
      if (!menuRef.current) return
      if (!menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', handleDown)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleDown)
      document.removeEventListener('keydown', handleKey)
    }
  }, [menuOpen])

  return (
    <article
      ref={setNodeRef}
      style={style}
      aria-label={`Slot ${title}`}
      data-testid="mealplan-slot"
      className={cn(
        'flex items-start gap-2 rounded-md border border-border bg-background px-2 py-2 text-sm shadow-sm transition-colors',
        isDragging && 'border-primary shadow-md',
      )}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        data-testid={`mealplan-slot-drag-${slot.id}`}
        aria-label={`Slot verschieben: ${title}`}
        className="grid h-8 w-5 flex-none place-items-center rounded text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary active:cursor-grabbing"
        style={{ touchAction: 'none', cursor: 'grab' }}
      >
        <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
      </button>

      <button
        type="button"
        onClick={onEdit}
        aria-label={`Slot bearbeiten: ${title}`}
        data-testid={`mealplan-slot-edit-${slot.id}`}
        className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
      >
        <p
          className={cn(
            'truncate font-medium text-foreground',
            slot.isCooked && 'line-through',
          )}
        >
          {title}
        </p>
        <p className="text-[11px] text-muted-foreground">
          {slot.servings} {servingsLabel}
        </p>
        {parentLabel && (
          <span
            data-testid={`mealplan-slot-parent-badge-${slot.id}`}
            className="mt-1 inline-flex items-center gap-1 rounded-full bg-secondary/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
          >
            <Repeat className="h-3 w-3" aria-hidden="true" />
            Rest von {parentLabel}
          </span>
        )}
      </button>

      <div className="flex flex-none items-center gap-1.5">
        <label
          className="inline-flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={slot.isCooked}
            onChange={(e) => onToggleCooked(e.target.checked)}
            aria-label={`Gericht als gekocht markieren: ${title}`}
            data-testid={`mealplan-slot-cooked-toggle-${slot.id}`}
            className="h-3.5 w-3.5 rounded border-input text-primary focus:ring-2 focus:ring-ring/40"
          />
          <span className="select-none">Gekocht</span>
        </label>
        {slot.isCooked && (
          <span
            aria-label="Gekocht"
            className="inline-flex items-center text-[hsl(var(--primary))]"
            data-testid="mealplan-slot-cooked"
          >
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
          </span>
        )}

        <div ref={menuRef} className="relative">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              setMenuOpen((v) => !v)
            }}
            aria-label={`Weitere Aktionen: ${title}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            data-testid={`mealplan-slot-menu-${slot.id}`}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
          >
            <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
          </button>
          {menuOpen && (
            <div
              role="menu"
              aria-label="Slot-Aktionen"
              className="absolute right-0 top-8 z-10 min-w-[140px] rounded-md border border-border bg-background p-1 shadow-md"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false)
                  onEdit()
                }}
                className="block w-full rounded px-2 py-1.5 text-left text-sm text-foreground hover:bg-primary/10"
              >
                Bearbeiten
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false)
                  onDelete()
                }}
                className="block w-full rounded px-2 py-1.5 text-left text-sm text-[hsl(var(--destructive))] hover:bg-[hsl(var(--destructive)/0.1)]"
              >
                Löschen
              </button>
            </div>
          )}
        </div>
      </div>
    </article>
  )
}
