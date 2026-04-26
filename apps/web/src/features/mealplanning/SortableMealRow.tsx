import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  CheckCircle2,
  ExternalLink,
  GripVertical,
  MoreHorizontal,
  Repeat,
} from 'lucide-react'
import type { MealPlanSlotDto } from '@shared-cookbook/shared'
import { cn } from '@/lib/utils'

/**
 * @dnd-kit `PointerSensor` activation constraint for the Wochenplan grid.
 *
 * - `distance: 5` — the pointer has to travel 5 px before drag starts.
 *   On mobile, fingers wobble during a tap; without a movement
 *   threshold, every list-tap turns into an accidental drag.
 * - `delay: 200` — adds a 200 ms hold-window so a quick tap on a card
 *   keeps reaching its onClick handler (edit dialog) instead of being
 *   intercepted by the sortable layer.
 * - `tolerance: 5` — pointer is allowed to drift 5 px during the delay
 *   window without cancelling the activation; matches `distance` so
 *   the user-feel is symmetric on touch + mouse.
 *
 * Exported so tests + future feature code can reference the same constant
 * — see `SortableMealRow.test.tsx` for the lock-in assertion.
 */
export const MEALPLAN_POINTER_ACTIVATION = {
  distance: 5,
  delay: 200,
  tolerance: 5,
} as const

/**
 * Renders all slots within a single `(date, meal)` cell as a sortable
 * list. As of v0.15.0 the `DndContext` lives one level up at the
 * meal-plan page (see `MealPlanDndProvider`) so a single drag can
 * cross between cells — this component keeps just the per-cell
 * `SortableContext` + the slot cards.
 *
 * The reorder scheme steps by `SORT_ORDER_STEP` (see `constants.ts`) so
 * later phases can insert a slot between two existing ones without
 * a global reindex. The page-level `handleDragEnd` always reindexes
 * the affected bucket via `arrayMove`, but the spacing leaves room
 * for between-slot insertion to land cheaply later.
 */
export function SortableMealRow({
  groupId,
  slots,
  onEdit,
  onDelete,
  onToggleCooked,
  getParentLabel,
}: {
  /**
   * Owning group ID — used to build the open-recipe link target
   * (`/groups/{groupId}/recipes/{recipeId}`). Threaded down from
   * MealPlanPage which already has it from the route.
   */
  groupId: string
  slots: readonly MealPlanSlotDto[]
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
  if (slots.length === 0) return null

  return (
    <SortableContext
      items={slots.map((s) => s.id)}
      strategy={verticalListSortingStrategy}
    >
      <ul className="space-y-1.5">
        {slots.map((slot) => (
          <li key={slot.id}>
            <SortableSlotCard
              groupId={groupId}
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
  groupId,
  slot,
  parentLabel,
  onEdit,
  onDelete,
  onToggleCooked,
}: {
  groupId: string
  slot: MealPlanSlotDto
  parentLabel: string | null
  onEdit: () => void
  onDelete: () => void
  onToggleCooked: (next: boolean) => void
}) {
  const navigate = useNavigate()
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: slot.id })

  // v0.15.0 Bug 1 — title fallback chain: explicit user label wins,
  // then the resolved recipe title from the BE (RecipeTitle on the
  // DTO), then the literal "Rezept" placeholder for slots that link
  // a soft-deleted recipe, finally "Unbenanntes Gericht" for fully
  // empty slots (defence-in-depth — the BE rejects creating such a
  // slot, but the FE renders something rather than blank if state
  // ever lands like this).
  const title =
    slot.label?.trim() ||
    slot.recipeTitle ||
    (slot.recipeId ? 'Rezept' : 'Unbenanntes Gericht')
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
        {/* Badge sits inside the click-to-edit button intentionally — clicking badge opens edit dialog. If wrapped in a nested interactive element later, extract to a top-right absolute-positioned element. */}
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

        {/*
          v0.15.0 Bug 3 — explicit "go to recipe" affordance. Renders
          only when a recipe is linked. Clicking the card body still
          opens the edit dialog (consistent with the existing UX users
          learned); this icon is the explicit navigate path. Same
          ≥44 × 44 hit-target convention as the overflow-menu trigger.
        */}
        {slot.recipeId !== null && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              navigate(`/groups/${groupId}/recipes/${slot.recipeId}`)
            }}
            aria-label={`Rezept öffnen: ${title}`}
            data-testid={`mealplan-slot-open-recipe-${slot.id}`}
            className="grid min-h-[44px] min-w-[44px] place-items-center rounded-md text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
          >
            <span
              aria-hidden="true"
              className="grid h-7 w-7 place-items-center"
            >
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
            </span>
          </button>
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
            // ≥44×44 hit target per WCAG 2.5.5 / Apple HIG — the button
            // is the 44px tap surface; the inner `<span>` carries the
            // compact 28px visual chrome so finger users don't have to
            // aim at the icon-sized square (mirrors the pattern used in
            // `ShoppingListPage.tsx` checkbox rows).
            className="grid min-h-[44px] min-w-[44px] place-items-center rounded-md text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
          >
            <span
              aria-hidden="true"
              className="grid h-7 w-7 place-items-center"
            >
              <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
            </span>
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
