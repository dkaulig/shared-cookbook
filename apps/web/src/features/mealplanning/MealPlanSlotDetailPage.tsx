import { Link, useParams } from 'react-router-dom'
import { CalendarDays, CheckCircle2, ChefHat, Circle, ExternalLink, Users } from 'lucide-react'
import type { MealPlanSlotDto } from '@shared-cookbook/shared'
import { cn } from '@/lib/utils'
import { useMealPlan } from './useMealPlan'
import {
  MEAL_SLOT_LABELS,
  WEEKDAY_LABELS,
  formatGermanDate,
  isMonday,
  toMondayIso,
} from './weekGrid'

/**
 * TABLET-2 — read-only slot-detail view rendered inside the MealPlanPage
 * SplitPane's right column at md:+.
 *
 * Route: `/groups/:groupId/mealplan/:weekStart/slots/:slotId`. The
 * component re-reads the week's plan from the TanStack-Query cache (no
 * extra fetch; the parent `<MealPlanPage />` has already primed it) and
 * pulls the slot by id. If the slot isn't in the current plan (stale
 * link, deleted slot, wrong week) we render a small "not found" note
 * with a link back to the week so the user isn't stuck.
 *
 * Write actions (edit / delete / cook) remain on the existing dialogs
 * in `MealPlanPage` — the detail here is a lightweight summary card
 * matching the "Wähle einen Slot links, um Details zu sehen." empty-
 * state prompt. Keeping writes in the dialog flow avoids duplicating
 * the AddSlot / EditSlot form UX and stays in line with the TABLET-2
 * scope ("slot-detail view, not full edit surface").
 */
export function MealPlanSlotDetailPage() {
  const params = useParams<{
    groupId: string
    weekStart: string
    slotId: string
  }>()
  const groupId = params.groupId ?? ''
  const rawWeek = params.weekStart ?? ''
  const slotId = params.slotId ?? ''
  // Snap to Monday for safety — the parent page already redirects mid-
  // week URLs to their Monday, but if this child renders during the
  // navigation tick we'd miss the plan otherwise.
  const weekStart = rawWeek
    ? isMonday(rawWeek)
      ? rawWeek
      : toMondayIso(rawWeek)
    : ''

  const { plan, isLoading } = useMealPlan(
    groupId || undefined,
    weekStart || undefined,
  )

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center px-6 py-10 text-center text-[hsl(var(--muted-foreground))]">
        <p className="text-sm">Slot wird geladen …</p>
      </div>
    )
  }

  const slot = plan?.slots.find((s) => s.id === slotId) ?? null
  if (!slot) {
    return (
      <div className="flex h-full items-center justify-center px-6 py-10 text-center text-[hsl(var(--muted-foreground))]">
        <div className="max-w-sm">
          <p className="text-[15px] leading-[1.5]">
            Slot nicht gefunden. Vielleicht wurde er gelöscht.
          </p>
          <Link
            to={`/groups/${groupId}/mealplan/${weekStart}`}
            className="mt-3 inline-block text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            Zurück zum Wochenplan
          </Link>
        </div>
      </div>
    )
  }

  return <SlotDetailBody slot={slot} groupId={groupId} />
}

function SlotDetailBody({
  slot,
  groupId,
}: {
  slot: MealPlanSlotDto
  groupId: string
}) {
  // Weekday label — derive from the slot's date. `Date.parse` on an
  // ISO-date is UTC, so we new-up the date and read getUTCDay() / map
  // it into our Mon-first array.
  const d = new Date(slot.date + 'T00:00:00Z')
  const isoDay = d.getUTCDay() // 0 = Sunday … 6 = Saturday
  const mondayIndex = (isoDay + 6) % 7 // 0 = Monday … 6 = Sunday
  const weekdayLabel = WEEKDAY_LABELS[mondayIndex] ?? ''
  const title = slot.label ?? 'Unbenanntes Gericht'

  return (
    <article
      aria-label={`Slot-Detail: ${title}`}
      className="mx-auto w-full max-w-lg px-5 py-6 md:px-8 md:py-8"
    >
      <header>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {MEAL_SLOT_LABELS[slot.meal]}
        </p>
        <h2 className="mt-1 font-serif text-[clamp(22px,3vw,28px)] font-semibold leading-tight text-foreground">
          {title}
        </h2>
        <p className="mt-1 inline-flex items-center gap-1.5 text-sm text-muted-foreground">
          <CalendarDays className="h-4 w-4" aria-hidden="true" />
          {weekdayLabel}, {formatGermanDate(slot.date)}
        </p>
      </header>

      <dl className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-[14px] border border-border bg-card/60 px-4 py-3">
          <dt className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            <Users className="h-3.5 w-3.5" aria-hidden="true" />
            Portionen
          </dt>
          <dd className="mt-1 text-lg font-semibold text-foreground">
            {slot.servings}
          </dd>
        </div>
        <div className="rounded-[14px] border border-border bg-card/60 px-4 py-3">
          <dt className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            <ChefHat className="h-3.5 w-3.5" aria-hidden="true" />
            Status
          </dt>
          <dd
            className={cn(
              'mt-1 inline-flex items-center gap-1.5 text-sm font-medium',
              slot.isCooked ? 'text-primary' : 'text-muted-foreground',
            )}
          >
            {slot.isCooked ? (
              <>
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                Gekocht
              </>
            ) : (
              <>
                <Circle className="h-4 w-4" aria-hidden="true" />
                Offen
              </>
            )}
          </dd>
        </div>
      </dl>

      {slot.recipeId && (
        <div className="mt-5">
          <Link
            to={`/groups/${groupId}/recipes/${slot.recipeId}`}
            className="inline-flex items-center gap-1.5 rounded-[10px] border border-border bg-card/60 px-3 py-2 text-sm font-medium text-foreground transition-colors hover:border-primary/60 hover:bg-primary/5"
          >
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
            Rezept öffnen
          </Link>
        </div>
      )}

      <p className="mt-6 text-xs text-muted-foreground">
        Bearbeiten oder löschen über die Slot-Karte im Wochenplan.
      </p>
    </article>
  )
}
