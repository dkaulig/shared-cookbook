import { useMemo, useState } from 'react'
import { ChevronDown, Plus } from 'lucide-react'
import type { MealPlanSlotDto, MealSlot } from '@shared-cookbook/shared'
import { cn } from '@/lib/utils'
import { SortableMealRow } from './SortableMealRow'
import {
  MEAL_SLOTS,
  MEAL_SLOT_LABELS,
  WEEKDAY_LABELS,
  dayKeys,
  formatGermanDate,
} from './weekGrid'
import { defaultOpenDays } from './mobileDayStackHelpers'

/**
 * Mobile (< 768 px) layout for the Wochenplan: the 7-day × 4-meal grid
 * collapses into a vertical stack of accordions, one per weekday. By
 * default we auto-expand today + the next day (fallback: Monday when
 * today is outside the current week) so the most-likely action "plan
 * today's meal" is one tap away; the remaining days stay collapsed to
 * keep the vertical scroll tractable on small screens.
 *
 * Rendered by MealPlanPage.tsx only when useIsMobile() returns true.
 * NOTE: layout swap is React-conditional (not CSS-driven), so resizing
 * across the 768px breakpoint unmounts the tree. In-flight dnd-kit
 * drag state and accordion openDays state are lost on resize; dialogs
 * are rendered at the top level of MealPlanPage, so they survive.
 *
 * Touch-target audit (plan §P3-10): the day-toggle button is a full-
 * width row with a 56-px minimum height — comfortably exceeds the
 * 44 × 44 minimum. The empty-cell add buttons are sized to the same
 * `min-h-[44px]` constraint.
 */
export function MobileDayStack({
  groupId,
  weekStart,
  bucketsByDay,
  onAdd,
  onEdit,
  onDelete,
  onReorder,
  onToggleCooked,
  getParentLabel,
}: {
  groupId: string
  weekStart: string
  bucketsByDay: Record<string, Record<MealSlot, MealPlanSlotDto[]>>
  onAdd: (date: string, meal: MealSlot) => void
  onEdit: (slot: MealPlanSlotDto) => void
  onDelete: (slot: MealPlanSlotDto) => void
  onReorder: (orderedIds: readonly string[]) => void
  onToggleCooked: (slot: MealPlanSlotDto, nextCooked: boolean) => void
  getParentLabel?: (slot: MealPlanSlotDto) => string | null
}) {
  // Day-keys never change unless the week navigation moves — memoise so
  // we don't churn array identity on unrelated re-renders.
  const days = useMemo(() => dayKeys(weekStart), [weekStart])

  // Track which day-accordions are open. Default: today + tomorrow when
  // today falls inside this week (most-likely action "plan today's meal"
  // is one tap away + "what's tomorrow?" peek); fallback to Monday when
  // the user is browsing a historical or future week where "today" is
  // not in range. See `defaultOpenDays` for the pure helper + tests.
  const [openDays, setOpenDays] = useState<Set<string>>(
    () =>
      new Set(
        defaultOpenDays(weekStart, new Date().toISOString().split('T')[0] ?? ''),
      ),
  )

  const toggleDay = (date: string) => {
    setOpenDays((prev) => {
      const next = new Set(prev)
      if (next.has(date)) {
        next.delete(date)
      } else {
        next.add(date)
      }
      return next
    })
  }

  return (
    <ul
      data-testid="mealplan-mobile-stack"
      className="space-y-2"
      aria-label="Wochenplan nach Tagen"
    >
      {days.map((date, index) => {
        const buckets = bucketsByDay[date] ?? {
          Frühstück: [],
          Mittag: [],
          Abend: [],
          Snack: [],
        }
        const weekday = WEEKDAY_LABELS[index] ?? ''
        const isOpen = openDays.has(date)
        const slotCount =
          buckets.Frühstück.length +
          buckets.Mittag.length +
          buckets.Abend.length +
          buckets.Snack.length
        const panelId = `mobile-day-panel-${date}`
        return (
          <li
            key={date}
            className="overflow-hidden rounded-[14px] border border-border bg-card/60"
          >
            <button
              type="button"
              data-testid={`mobile-day-toggle-${date}`}
              aria-expanded={isOpen}
              aria-controls={panelId}
              onClick={() => toggleDay(date)}
              className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors min-h-[56px] hover:bg-primary/5"
            >
              <span className="flex flex-col">
                <span className="font-serif text-[15px] font-semibold text-foreground">
                  {weekday}
                </span>
                <span className="text-[12px] text-muted-foreground">
                  {formatGermanDate(date)}
                </span>
              </span>
              <span className="flex items-center gap-2">
                <span className="rounded-full bg-secondary/60 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                  {slotCountLabel(slotCount)}
                </span>
                <ChevronDown
                  aria-hidden="true"
                  className={cn(
                    'h-4 w-4 text-muted-foreground transition-transform',
                    isOpen && 'rotate-180',
                  )}
                />
              </span>
            </button>
            {isOpen && (
              <div
                id={panelId}
                role="region"
                aria-label={`${weekday} ${formatGermanDate(date)}`}
                className="space-y-3 border-t border-border/60 px-3 py-3"
              >
                {MEAL_SLOTS.map((meal) => (
                  <MobileMealCell
                    key={meal}
                    groupId={groupId}
                    date={date}
                    meal={meal}
                    slots={buckets[meal]}
                    onAdd={() => onAdd(date, meal)}
                    onEdit={onEdit}
                    onDelete={onDelete}
                    onReorder={onReorder}
                    onToggleCooked={onToggleCooked}
                    getParentLabel={getParentLabel}
                  />
                ))}
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function slotCountLabel(count: number): string {
  if (count === 0) return 'Keine Gerichte'
  if (count === 1) return '1 Gericht'
  return `${count} Gerichte`
}

function MobileMealCell({
  groupId,
  date,
  meal,
  slots,
  onAdd,
  onEdit,
  onDelete,
  onReorder,
  onToggleCooked,
  getParentLabel,
}: {
  groupId: string
  date: string
  meal: MealSlot
  slots: MealPlanSlotDto[]
  onAdd: () => void
  onEdit: (slot: MealPlanSlotDto) => void
  onDelete: (slot: MealPlanSlotDto) => void
  onReorder: (orderedIds: readonly string[]) => void
  onToggleCooked: (slot: MealPlanSlotDto, nextCooked: boolean) => void
  getParentLabel?: (slot: MealPlanSlotDto) => string | null
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {MEAL_SLOT_LABELS[meal]}
        </span>
        <button
          type="button"
          onClick={onAdd}
          aria-label={`Gericht hinzufügen: ${MEAL_SLOT_LABELS[meal]} am ${formatGermanDate(date)}`}
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      {slots.length === 0 ? (
        <button
          type="button"
          onClick={onAdd}
          className="block w-full rounded-md border border-dashed border-input bg-background/60 px-3 py-3 text-left text-[12px] italic text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/5"
        >
          Noch keine Gerichte für diesen Tag
        </button>
      ) : (
        <SortableMealRow
          groupId={groupId}
          slots={slots}
          onEdit={onEdit}
          onDelete={onDelete}
          onReorder={onReorder}
          onToggleCooked={onToggleCooked}
          getParentLabel={getParentLabel}
        />
      )}
    </div>
  )
}
