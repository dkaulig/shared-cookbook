import { useMemo, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Plus,
} from 'lucide-react'
import type { MealPlanSlotDto, MealSlot } from '@familien-kochbuch/shared'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { AddSlotDialog } from './AddSlotDialog'
import { useCreateMealPlan, useMealPlan } from './useMealPlan'
import {
  MEAL_SLOTS,
  MEAL_SLOT_LABELS,
  WEEKDAY_LABELS,
  dayKeys,
  formatGermanDate,
  formatWeekRange,
  isMonday,
  isoWeekNumber,
  nextMonday,
  prevMonday,
  slotsByDayMeal,
  toMondayIso,
} from './weekGrid'

/**
 * P3-2 Wochenplan page.
 *
 *   - 7-day × 4-meal grid (Frühstück / Mittag / Abend / Snack).
 *   - 404 from GET → "Kein Plan für diese Woche — anlegen?" CTA which
 *     fires the POST create-plan call then lets TanStack-Query refetch.
 *   - Each slot is a read-only card (edit / drag / mark-cooked land in
 *     P3-3); clicking an empty cell opens the AddSlotDialog pre-filled
 *     with that day + meal.
 *   - Week-navigation: prev/next arrows change the URL param so the view
 *     stays shareable and the browser back-button works.
 *
 * The route lives at `/groups/:groupId/mealplan/:weekStart`. When the
 * `:weekStart` is missing or malformed we redirect to the Monday of the
 * current week so direct links stay forgiving.
 */
export function MealPlanPage() {
  const params = useParams<{ groupId: string; weekStart: string }>()
  const navigate = useNavigate()
  const groupId = params.groupId ?? ''
  const rawWeek = params.weekStart ?? ''
  const [openCell, setOpenCell] = useState<{ date: string; meal: MealSlot } | null>(null)

  const weekStart = useMemo(() => {
    if (!rawWeek) return ''
    // Tolerate any valid date — snap to Monday so the grid always works.
    try {
      return isMonday(rawWeek) ? rawWeek : toMondayIso(rawWeek)
    } catch {
      return ''
    }
  }, [rawWeek])

  const { plan, notFound, isLoading, isError, refetch } = useMealPlan(
    groupId,
    weekStart || undefined,
  )
  const create = useCreateMealPlan(groupId)

  if (!groupId) return <Navigate to="/groups" replace />

  if (!weekStart) {
    // Invalid / missing weekStart → redirect to current week's Monday.
    // The ISO cast drops the time component.
    const today = new Date().toISOString().slice(0, 10)
    return <Navigate to={`/groups/${groupId}/mealplan/${toMondayIso(today)}`} replace />
  }

  // If the raw URL segment wasn't already a Monday (e.g. shared link
  // with mid-week date), correct it so the next/prev buttons stay on
  // Monday boundaries.
  if (rawWeek !== weekStart) {
    return (
      <Navigate to={`/groups/${groupId}/mealplan/${weekStart}`} replace />
    )
  }

  const goTo = (targetWeek: string) =>
    navigate(`/groups/${groupId}/mealplan/${targetWeek}`)

  async function handleCreatePlan() {
    await create.mutateAsync({ weekStart })
    await refetch()
  }

  const buckets = plan ? slotsByDayMeal(plan.slots, weekStart) : null
  const weekNumber = isoWeekNumber(weekStart)

  return (
    <div className="mx-auto w-full max-w-[1280px]">
      <nav
        className={cn(
          'sticky top-[56px] z-[9] flex items-center gap-2.5 border-b border-border/60 px-4 py-2.5',
          'bg-[hsl(var(--background)/0.88)] backdrop-blur supports-[backdrop-filter]:bg-[hsl(var(--background)/0.75)]',
        )}
        aria-label="Wochenplan-Navigation"
      >
        <Link
          to={`/groups/${groupId}`}
          aria-label="Zurück zur Gruppe"
          className="grid h-10 w-10 place-items-center rounded-[10px] text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--primary)/0.08)] hover:text-foreground"
        >
          <ArrowLeft className="h-[18px] w-[18px]" aria-hidden="true" />
        </Link>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <CalendarDays
            className="h-[18px] w-[18px] text-[hsl(var(--muted-foreground))]"
            aria-hidden="true"
          />
          <span className="truncate font-serif text-[18px] font-semibold tracking-[-0.005em]">
            Wochenplan
          </span>
        </div>
      </nav>

      <header className="flex flex-wrap items-center justify-between gap-3 px-5 pt-6 md:px-8">
        <div>
          <h1 className="font-serif text-[clamp(24px,4vw,32px)] font-semibold leading-tight">
            KW {weekNumber}
          </h1>
          <p className="text-sm text-muted-foreground">
            vom {formatWeekRange(weekStart)}
          </p>
        </div>
        <div className="inline-flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => goTo(prevMonday(weekStart))}
            aria-label="Vorherige Woche"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => goTo(nextMonday(weekStart))}
            aria-label="Nächste Woche"
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </header>

      <main className="px-5 pb-10 pt-4 md:px-8">
        {isLoading && (
          <div className="grid gap-3 md:grid-cols-4">
            {[0, 1, 2, 3, 4, 5, 6].map((i) => (
              <Skeleton key={i} className="h-48 w-full rounded-[18px]" />
            ))}
          </div>
        )}

        {isError && (
          <p
            role="alert"
            className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200"
          >
            Der Wochenplan konnte nicht geladen werden.
          </p>
        )}

        {notFound && (
          <EmptyPlanState
            onCreate={handleCreatePlan}
            isPending={create.isPending}
            errorMessage={create.isError ? 'Plan konnte nicht angelegt werden.' : null}
          />
        )}

        {plan && buckets && (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
            {dayKeys(weekStart).map((dateKey, index) => {
              // `buckets` is guaranteed to have every day-key by
              // construction in `slotsByDayMeal`, but
              // `noUncheckedIndexedAccess` doesn't know that. Default
              // to an empty bucket rather than narrowing so a broken
              // invariant still renders something useful.
              const dayBuckets = buckets[dateKey] ?? {
                Frühstück: [],
                Mittag: [],
                Abend: [],
                Snack: [],
              }
              const weekday = WEEKDAY_LABELS[index] ?? ''
              return (
                <DayColumn
                  key={dateKey}
                  date={dateKey}
                  weekdayLabel={weekday}
                  buckets={dayBuckets}
                  onAdd={(meal) => setOpenCell({ date: dateKey, meal })}
                />
              )
            })}
          </div>
        )}
      </main>

      {openCell && plan && (
        <AddSlotDialog
          groupId={groupId}
          weekStart={weekStart}
          planId={plan.id}
          initialDate={openCell.date}
          initialMeal={openCell.meal}
          onClose={() => setOpenCell(null)}
        />
      )}
    </div>
  )
}

function DayColumn({
  date,
  weekdayLabel,
  buckets,
  onAdd,
}: {
  date: string
  weekdayLabel: string
  buckets: Record<MealSlot, MealPlanSlotDto[]>
  onAdd: (meal: MealSlot) => void
}) {
  return (
    <section
      aria-label={`${weekdayLabel} ${formatGermanDate(date)}`}
      className="rounded-[18px] border border-border bg-card/60 p-3"
    >
      <header className="mb-2 flex items-baseline justify-between">
        <span className="font-serif text-[15px] font-semibold text-foreground">
          {weekdayLabel}
        </span>
        <span className="text-[11px] text-muted-foreground">
          {formatGermanDate(date)}
        </span>
      </header>
      <div className="space-y-3">
        {MEAL_SLOTS.map((meal) => (
          <MealCell
            key={meal}
            date={date}
            meal={meal}
            slots={buckets[meal]}
            onAdd={() => onAdd(meal)}
          />
        ))}
      </div>
    </section>
  )
}

function MealCell({
  date,
  meal,
  slots,
  onAdd,
}: {
  date: string
  meal: MealSlot
  slots: MealPlanSlotDto[]
  onAdd: () => void
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
          className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
      {slots.length === 0 ? (
        <button
          type="button"
          onClick={onAdd}
          className="block w-full rounded-md border border-dashed border-input bg-background/60 px-2 py-3 text-left text-[12px] italic text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/5"
        >
          Noch keine Gerichte für diesen Tag
        </button>
      ) : (
        <ul className="space-y-1.5">
          {slots.map((slot) => (
            <li key={slot.id}>
              <SlotCard slot={slot} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function SlotCard({ slot }: { slot: MealPlanSlotDto }) {
  const title = slot.label?.trim() || (slot.recipeId ? 'Rezept' : 'Unbenanntes Gericht')
  const servingsLabel = slot.servings === 1 ? 'Portion' : 'Portionen'
  return (
    <article
      aria-label={`Slot ${title}`}
      data-testid="mealplan-slot"
      className="flex items-start justify-between gap-2 rounded-md border border-border bg-background px-2.5 py-2 text-sm shadow-sm"
    >
      <div className="min-w-0">
        <p className="truncate font-medium text-foreground">{title}</p>
        <p className="text-[11px] text-muted-foreground">
          {slot.servings} {servingsLabel}
        </p>
      </div>
      {slot.isCooked && (
        <span
          aria-label="Gekocht"
          className="inline-flex items-center text-[hsl(var(--primary))]"
          data-testid="mealplan-slot-cooked"
        >
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
        </span>
      )}
    </article>
  )
}

function EmptyPlanState({
  onCreate,
  isPending,
  errorMessage,
}: {
  onCreate: () => void
  isPending: boolean
  errorMessage: string | null
}) {
  return (
    <div className="rounded-[18px] border border-dashed border-[hsl(var(--input))] bg-card/60 px-6 py-10 text-center">
      <CalendarDays
        className="mx-auto mb-3 h-8 w-8 text-muted-foreground"
        aria-hidden="true"
      />
      <h2 className="font-serif text-[22px] font-semibold text-foreground">
        Kein Plan für diese Woche
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Lege jetzt einen leeren Wochenplan an — Gerichte kannst du direkt im
        Anschluss ziehen.
      </p>
      <div className="mt-4">
        <Button type="button" onClick={onCreate} disabled={isPending}>
          {isPending ? 'Wird angelegt …' : 'Wochenplan anlegen'}
        </Button>
      </div>
      {errorMessage && (
        <p
          role="alert"
          className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200"
        >
          {errorMessage}
        </p>
      )}
    </div>
  )
}
