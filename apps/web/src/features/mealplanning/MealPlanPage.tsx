import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Link,
  Navigate,
  useNavigate,
  useOutlet,
  useParams,
  useSearchParams,
} from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CopyPlus,
  Plus,
  ShoppingBasket,
} from 'lucide-react'
import type { MealPlanSlotDto, MealSlot, PatchSlotRequest } from '@familien-kochbuch/shared'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { SplitPane } from '@/components/layout/SplitPane'
import { useIsMobile } from '@/lib/useIsMobile'
import { cn } from '@/lib/utils'
import { ConfirmDialog } from '@/features/_shared/ConfirmDialog'
import {
  ConflictDialog,
  useConflictResolver,
} from '@/features/_shared/ConflictDialog'
import { VersionMismatchError } from '@/features/_shared/apiError'
import { AddSlotDialog } from './AddSlotDialog'
import { DeleteSlotDialog } from './DeleteSlotDialog'
import { EditSlotDialog } from './EditSlotDialog'
import { MobileDayStack } from './MobileDayStack'
import { SortableMealRow } from './SortableMealRow'
import { SlotConflictBody } from './SlotConflictBody'
import { SORT_ORDER_STEP } from './constants'
import { MealPlanApiError, patchSlot as patchSlotApi } from './mealPlanApi'
import {
  buildParentLabel,
  childrenOf,
} from './parentSlotHelpers'
import {
  mealPlanQueryKeys,
  useCopyFromWeek,
  useCreateMealPlan,
  useMealPlan,
  usePatchSlot,
} from './useMealPlan'
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
  const [searchParams, setSearchParams] = useSearchParams()
  const groupId = params.groupId ?? ''
  const rawWeek = params.weekStart ?? ''
  // BUG-007: when the recipe-detail "In Wochenplan" button hands off
  // a recipe via `?addRecipeId=…`, we pre-open AddSlotDialog with that
  // recipe selected so the user only has to confirm the day + meal.
  const addRecipeId = searchParams.get('addRecipeId')
  const [prefilledRecipeId, setPrefilledRecipeId] = useState<string | null>(null)
  const [openCell, setOpenCell] = useState<{ date: string; meal: MealSlot } | null>(null)
  const [editSlot, setEditSlot] = useState<MealPlanSlotDto | null>(null)
  const [deleteSlotState, setDeleteSlotState] = useState<MealPlanSlotDto | null>(null)
  const [reorderError, setReorderError] = useState<string | null>(null)
  const [copyBanner, setCopyBanner] = useState<
    { kind: 'success'; message: string } | { kind: 'error'; message: string } | null
  >(null)
  // BUG-004 — the non-empty-plan override guard used to fire a native
  // `window.confirm`. We now stage it through the shared ConfirmDialog
  // so the UX stays in-theme with the rest of the app.
  const [copyOverrideOpen, setCopyOverrideOpen] = useState(false)
  const queryClient = useQueryClient()
  // P3-10 mobile polish: react to viewport-width crossings of the
  // Tailwind `md:` breakpoint so we render exactly one of the two
  // layouts at any time. Tests rely on the single-render guarantee to
  // keep their `data-testid` lookups unique.
  const isMobile = useIsMobile()

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
  // The patch + delete hooks require a planId. We wire them with the
  // current plan's id when it exists; the empty-string fallback keeps
  // the hook call-order stable across renders (required by React's
  // rules-of-hooks). The mutations are only triggered from UI that
  // only renders when `plan` is truthy, so the empty-string branch
  // never reaches the network.
  const planId = plan?.id ?? ''
  const patchMutation = usePatchSlot(groupId, weekStart || '', planId)
  const copyMutation = useCopyFromWeek(groupId, weekStart || '', planId)

  // OFF4 — conflict resolver for slot patches. We track the last-
  // dispatched patch so keep-local can re-fire it against the server's
  // current plan-version. The dialog's wrapper type (`SlotWithVersion`)
  // carries the plan's `version` so the resolver's generic constraint
  // `T extends { version: number }` is satisfied — MealPlanSlotDto
  // itself has no version field (the plan is the versioned aggregate).
  const pendingPatchRef = useRef<
    | {
        slotId: string
        patch: import('@familien-kochbuch/shared').PatchSlotRequest
        local: MealPlanSlotDto
      }
    | null
  >(null)
  const conflict = useConflictResolver<MealPlanSlotDto & { version: number }>({
    onKeepLocal: async (expectedVersion) => {
      const pending = pendingPatchRef.current
      if (!pending) return
      await patchMutation.mutateAsync({
        slotId: pending.slotId,
        patch: pending.patch,
        expectedVersion,
      })
    },
    onKeepServer: () => {
      void queryClient.invalidateQueries({
        queryKey: mealPlanQueryKeys.forWeek(groupId, weekStart || ''),
      })
    },
  })

  // `slotsByDayMeal` walks every slot + builds a 7×4 map; recomputing on
  // every render will start to matter once P3-3 drag adds re-render
  // pressure. Memoise on the pieces the grouping actually depends on.
  // Lives above the `<Navigate>` early-returns so the hook order stays
  // stable across renders (React's rules-of-hooks).
  const planSlots = plan?.slots
  const buckets = useMemo(
    () => (planSlots && weekStart ? slotsByDayMeal(planSlots, weekStart) : null),
    [planSlots, weekStart],
  )

  // Look-up from slot.id → the parent slot it references. Used to
  // hand SortableMealRow a short-label resolver for the P3-4 "Rest
  // von X" badge. Recomputes only when the plan's slot list changes.
  const slotById = useMemo(() => {
    if (!planSlots) return new Map<string, MealPlanSlotDto>()
    return new Map(planSlots.map((s) => [s.id, s]))
  }, [planSlots])
  const getParentLabel = useCallback(
    (slot: MealPlanSlotDto): string | null => {
      if (!slot.parentSlotId) return null
      const parent = slotById.get(slot.parentSlotId)
      if (!parent) return null
      return buildParentLabel(parent, { short: true })
    },
    [slotById],
  )

  // Direct-child count for the slot the user is about to delete — feeds
  // the DeleteSlotDialog's parent-deletion warning copy.
  const deleteChildCount = useMemo(() => {
    if (!deleteSlotState || !planSlots) return 0
    return childrenOf(deleteSlotState.id, planSlots).length
  }, [deleteSlotState, planSlots])

  // Reorder handler — receives the final ordered slot IDs for one
  // (date, meal) bucket and ships one PATCH per slot whose position
  // changed. Using a step of `SORT_ORDER_STEP` (10) leaves room for
  // future "drop between existing neighbours" insertions without a
  // full reindex — see P3-10 mobile polish in the master plan. Kept
  // above the early returns so the hook-order stays stable.
  //
  // Resilience: we apply ONE optimistic cache update for the whole
  // bucket (so the UI flips atomically), then ship PATCH calls in
  // parallel via `Promise.allSettled` — any rejection surfaces a
  // German-language banner + refetches server truth so the user isn't
  // left looking at a half-saved order.
  const handleReorder = useCallback(
    (orderedIds: readonly string[]) => {
      if (!plan || !planId || !weekStart) return
      const byId = new Map(plan.slots.map((s) => [s.id, s]))
      const updates: Array<{ slotId: string; sortOrder: number }> = []
      orderedIds.forEach((id, index) => {
        const slot = byId.get(id)
        if (!slot) return
        const nextSortOrder = index * SORT_ORDER_STEP
        if (slot.sortOrder === nextSortOrder) return
        updates.push({ slotId: id, sortOrder: nextSortOrder })
      })
      if (updates.length === 0) return

      const queryKey = mealPlanQueryKeys.forWeek(groupId, weekStart)
      // Single optimistic splice for the whole bucket — avoids a cascade
      // of per-slot re-renders and keeps the rollback path trivial.
      const previous = queryClient.getQueryData(queryKey)
      const updateMap = new Map(updates.map((u) => [u.slotId, u.sortOrder]))
      queryClient.setQueryData<typeof plan | null>(queryKey, (prev) => {
        if (!prev) return prev
        return {
          ...prev,
          slots: prev.slots.map((s) => {
            const next = updateMap.get(s.id)
            return next === undefined ? s : { ...s, sortOrder: next }
          }),
        }
      })

      void Promise.allSettled(
        updates.map((u) => {
          const patch: PatchSlotRequest = { sortOrder: u.sortOrder }
          return patchSlotApi(planId, u.slotId, patch)
        }),
      ).then((results) => {
        const anyRejected = results.some((r) => r.status === 'rejected')
        if (anyRejected) {
          // Server truth wins: roll back + refetch so the grid ends up
          // in a consistent state regardless of partial progress.
          queryClient.setQueryData(queryKey, previous)
          setReorderError(
            'Neu-Reihenfolge konnte nicht vollständig gespeichert werden — wird neu geladen.',
          )
          void queryClient.invalidateQueries({ queryKey })
        } else {
          // Cheap keep-alive invalidation so other tabs (and P3-8 SignalR
          // fan-out) see the updated order without polling.
          void queryClient.invalidateQueries({ queryKey })
        }
      })
    },
    [plan, planId, weekStart, groupId, queryClient],
  )

  // BUG-007 hand-off: once the plan resolves, open AddSlotDialog with
  // the prefilled recipe and clear the query string so a refresh / back
  // doesn't re-trigger the dialog. One-shot: we delete addRecipeId from
  // searchParams in the same pass, so the guard above short-circuits on
  // the next render. The seeded state is only the bootstrap value —
  // the dialog's subsequent onClose resets both to null.
  useEffect(() => {
    if (!addRecipeId || !plan || !weekStart) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot URL→state handoff with same-pass URL cleanup
    setPrefilledRecipeId(addRecipeId)
    setOpenCell({ date: weekStart, meal: 'Mittag' })
    const next = new URLSearchParams(searchParams)
    next.delete('addRecipeId')
    setSearchParams(next, { replace: true })
  }, [addRecipeId, plan, weekStart, searchParams, setSearchParams])

  const handleToggleCooked = useCallback(
    (slot: MealPlanSlotDto, nextCooked: boolean) => {
      const patch: PatchSlotRequest = { isCooked: nextCooked }
      const localProjection: MealPlanSlotDto = { ...slot, isCooked: nextCooked }
      pendingPatchRef.current = {
        slotId: slot.id,
        patch,
        local: localProjection,
      }
      patchMutation.mutate(
        { slotId: slot.id, patch },
        {
          onError: (err) => {
            if (err instanceof VersionMismatchError) {
              // Server 409 body is the full plan DTO (OFF3). Extract
              // the matching slot for the dialog — the slot carries
              // the plan's `version` for If-Match purposes so we copy
              // it onto the slot's synthetic `version` field required
              // by `useConflictResolver<T extends { version: number }>`.
              const plan = err.current as
                | { version: number; slots: MealPlanSlotDto[] }
                | null
              const serverSlot = plan?.slots?.find((s) => s.id === slot.id)
              if (!plan || !serverSlot) return
              conflict.captureFrom409(
                { ...localProjection, version: plan.version },
                { current: { ...serverSlot, version: plan.version } },
              )
            }
          },
        },
      )
    },
    [patchMutation, conflict],
  )

  // P3-9 "Plan der letzten Woche kopieren".
  //
  // Disabled whenever the target already has any slot — accidental
  // mass-duplication is the biggest foot-gun of a one-click copy. The
  // belt-and-suspenders ConfirmDialog fires only on the unlikely
  // path where a race (another tab, SignalR invalidation) re-populates
  // the plan between render + click.
  const runCopyLastWeek = useCallback(() => {
    if (!plan || !weekStart) return
    const prev = prevMonday(weekStart)
    const prevWeekNumber = isoWeekNumber(prev)
    setCopyBanner(null)
    copyMutation.mutate(
      { sourceWeekStart: prev },
      {
        onSuccess: (copied) => {
          setCopyBanner({
            kind: 'success',
            message: `Plan kopiert: ${copied.slots.length} Slots aus KW ${prevWeekNumber} übernommen.`,
          })
        },
        onError: (caught) => {
          setCopyBanner({
            kind: 'error',
            message: copyErrorMessage(caught, prevWeekNumber),
          })
        },
      },
    )
  }, [plan, weekStart, copyMutation])

  const handleCopyLastWeek = useCallback(() => {
    if (!plan || !weekStart) return
    if (plan.slots.length > 0) {
      // Race-window: the button is normally disabled while slots exist,
      // but SignalR + other-tab edits can re-populate the plan between
      // render and click. Route that through the shared confirm dialog
      // instead of the old native `window.confirm`.
      setCopyOverrideOpen(true)
      return
    }
    runCopyLastWeek()
  }, [plan, weekStart, runCopyLastWeek])

  // TABLET-2 — the slot-detail nested route renders inside the
  // SplitPane's right column at md:+. `useOutlet()` gives us `null`
  // when no child matches, which is the cleanest signal for the empty-
  // state prompt without coupling to a specific child path. Kept
  // above the early <Navigate> returns below so hook order stays
  // stable across renders (React's rules-of-hooks).
  const outletNode = useOutlet()

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

  const weekNumber = isoWeekNumber(weekStart)

  const weekContent = (
    <div className="mx-auto w-full max-w-[1280px]">
      {/* Sticky page sub-nav.
          BUG-032: switched from hard-coded `top-[56px] z-20` to
          `top-[var(--topnav-height)] z-10`. Anchoring `top` to the
          shared `--topnav-height` token means the sub-nav clips
          flush beneath the global TopNav even if its height ever
          changes. Dropping z-20→z-10 gives the TopNav (z-20) a clear
          win on any y-overlap during iOS/Chrome toolbar retraction
          (the user report: "schieben dich übereinander"). */}
      <nav
        className={cn(
          'sticky top-0 z-10 flex items-center gap-2.5 border-b border-border/60 px-4 py-2.5',
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
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleCopyLastWeek}
            disabled={!plan || plan.slots.length > 0 || copyMutation.isPending}
            aria-label="Plan der letzten Woche kopieren"
          >
            <CopyPlus className="mr-1.5 h-4 w-4" aria-hidden="true" />
            {copyMutation.isPending ? 'Wird kopiert …' : 'Letzte Woche kopieren'}
          </Button>
          <Button asChild type="button" variant="outline" size="sm">
            <Link
              to={`/groups/${groupId}/mealplan/${weekStart}/shopping-list`}
              aria-label="Einkaufsliste öffnen"
            >
              <ShoppingBasket className="mr-1.5 h-4 w-4" aria-hidden="true" />
              Einkaufsliste
            </Link>
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

        {reorderError && (
          <div
            role="alert"
            aria-live="polite"
            className="mb-3 flex items-start justify-between gap-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200"
          >
            <span>{reorderError}</span>
            <button
              type="button"
              onClick={() => setReorderError(null)}
              aria-label="Fehlermeldung schließen"
              className="text-red-800/70 underline-offset-2 hover:text-red-900 hover:underline"
            >
              Schließen
            </button>
          </div>
        )}

        {copyBanner && (
          <div
            role={copyBanner.kind === 'success' ? 'status' : 'alert'}
            aria-live="polite"
            data-testid="mealplan-copy-banner"
            className={cn(
              'mb-3 flex items-start justify-between gap-2 rounded-md px-3 py-2 text-sm ring-1',
              copyBanner.kind === 'success'
                ? 'bg-emerald-50 text-emerald-900 ring-emerald-200'
                : 'bg-red-50 text-red-800 ring-red-200',
            )}
          >
            <span>{copyBanner.message}</span>
            <button
              type="button"
              onClick={() => setCopyBanner(null)}
              aria-label="Meldung schließen"
              className={cn(
                'underline-offset-2 hover:underline',
                copyBanner.kind === 'success'
                  ? 'text-emerald-900/70 hover:text-emerald-900'
                  : 'text-red-800/70 hover:text-red-900',
              )}
            >
              Schließen
            </button>
          </div>
        )}

        {notFound && (
          <EmptyPlanState
            onCreate={handleCreatePlan}
            isPending={create.isPending}
            errorMessage={create.isError ? 'Plan konnte nicht angelegt werden.' : null}
          />
        )}

        {plan && buckets && (
          isMobile ? (
            <MobileDayStack
              weekStart={weekStart}
              bucketsByDay={buckets}
              onAdd={(date, meal) => setOpenCell({ date, meal })}
              onEdit={setEditSlot}
              onDelete={setDeleteSlotState}
              onReorder={handleReorder}
              onToggleCooked={handleToggleCooked}
              getParentLabel={getParentLabel}
            />
          ) : (
            <div
              data-testid="mealplan-desktop-grid"
              className="grid gap-4 md:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7"
            >
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
                    onEdit={setEditSlot}
                    onDelete={setDeleteSlotState}
                    onReorder={handleReorder}
                    onToggleCooked={handleToggleCooked}
                    getParentLabel={getParentLabel}
                  />
                )
              })}
            </div>
          )
        )}
      </main>
    </div>
  )

  const slotDetailPane = outletNode ?? (
    <div
      className="flex h-full items-center justify-center px-6 py-10 text-center text-[hsl(var(--muted-foreground))]"
      role="status"
    >
      <p className="max-w-sm text-[15px] leading-[1.5]">
        Wähle einen Slot links, um Details zu sehen.
      </p>
    </div>
  )

  const body = isMobile ? (
    weekContent
  ) : (
    <SplitPane
      leftLabel="Wochenplan-Übersicht"
      rightLabel="Slot-Detail"
      left={weekContent}
      right={slotDetailPane}
      className="h-full"
    />
  )

  return (
    <>
      {body}

      {openCell && plan && (
        <AddSlotDialog
          groupId={groupId}
          weekStart={weekStart}
          planId={plan.id}
          initialDate={openCell.date}
          initialMeal={openCell.meal}
          initialRecipeId={prefilledRecipeId}
          existingSlots={plan.slots}
          onClose={() => {
            setOpenCell(null)
            setPrefilledRecipeId(null)
          }}
        />
      )}

      {editSlot && plan && (
        <EditSlotDialog
          groupId={groupId}
          weekStart={weekStart}
          planId={plan.id}
          slot={editSlot}
          existingSlots={plan.slots}
          onClose={() => setEditSlot(null)}
        />
      )}

      {deleteSlotState && plan && (
        <DeleteSlotDialog
          groupId={groupId}
          weekStart={weekStart}
          planId={plan.id}
          slot={deleteSlotState}
          childCount={deleteChildCount}
          onClose={() => setDeleteSlotState(null)}
        />
      )}

      <ConfirmDialog
        open={copyOverrideOpen}
        onOpenChange={setCopyOverrideOpen}
        title="Plan enthält bereits Slots"
        description="Möchtest du trotzdem Slots aus der Vorwoche hinzufügen? Bestehende Einträge bleiben erhalten."
        confirmLabel="Trotzdem kopieren"
        confirmVariant="default"
        onConfirm={() => {
          setCopyOverrideOpen(false)
          runCopyLastWeek()
        }}
        isLoading={copyMutation.isPending}
      />

      {conflict.state && (
        <ConflictDialog<MealPlanSlotDto & { version: number }>
          open={conflict.state.open}
          onClose={conflict.close}
          title="Konflikt im Wochenplan"
          subtitle="Deine Änderungen konkurrieren mit einer Änderung vom Server. Wähle, welche Version gelten soll."
          currentServer={conflict.state.serverCurrent}
          localPending={conflict.state.localPending}
          renderDiff={({ current, local }) => (
            <SlotConflictBody current={current} local={local} />
          )}
          onKeepLocal={conflict.resolveKeepLocal}
          onKeepServer={conflict.resolveKeepServer}
          isLoading={patchMutation.isPending}
        />
      )}
    </>
  )
}

function DayColumn({
  date,
  weekdayLabel,
  buckets,
  onAdd,
  onEdit,
  onDelete,
  onReorder,
  onToggleCooked,
  getParentLabel,
}: {
  date: string
  weekdayLabel: string
  buckets: Record<MealSlot, MealPlanSlotDto[]>
  onAdd: (meal: MealSlot) => void
  onEdit: (slot: MealPlanSlotDto) => void
  onDelete: (slot: MealPlanSlotDto) => void
  onReorder: (orderedIds: readonly string[]) => void
  onToggleCooked: (slot: MealPlanSlotDto, nextCooked: boolean) => void
  getParentLabel: (slot: MealPlanSlotDto) => string | null
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
            onEdit={onEdit}
            onDelete={onDelete}
            onReorder={onReorder}
            onToggleCooked={onToggleCooked}
            getParentLabel={getParentLabel}
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
  onEdit,
  onDelete,
  onReorder,
  onToggleCooked,
  getParentLabel,
}: {
  date: string
  meal: MealSlot
  slots: MealPlanSlotDto[]
  onAdd: () => void
  onEdit: (slot: MealPlanSlotDto) => void
  onDelete: (slot: MealPlanSlotDto) => void
  onReorder: (orderedIds: readonly string[]) => void
  onToggleCooked: (slot: MealPlanSlotDto, nextCooked: boolean) => void
  getParentLabel: (slot: MealPlanSlotDto) => string | null
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
        <SortableMealRow
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

/**
 * Error copy for the "Letzte Woche kopieren" CTA. Mirrors the
 * `generateErrorMessage` pattern in ShoppingListPage: narrow via
 * `instanceof MealPlanApiError`, branch on status + code, fall
 * through to the generic German message. Kept local to this file
 * because the status→copy mapping is action-specific (the 404 here
 * references the *source week number*, which no sibling page cares
 * about). Promote to a shared helper once a second caller needs it.
 */
function copyErrorMessage(err: unknown, prevWeekNumber: number): string {
  if (err instanceof MealPlanApiError) {
    if (err.status === 404 || err.code === 'source.not_found') {
      return `Kein Plan in KW ${prevWeekNumber} gefunden.`
    }
    if (err.status === 409 && err.code === 'copy.target_not_empty') {
      return 'Zielplan enthält bereits Slots — Kopieren nur in leeren Plan möglich.'
    }
    if (err.status === 403) return 'Keine Berechtigung.'
    if (err.status === 429) return 'Zu viele Anfragen — bitte kurz warten.'
  }
  return 'Kopieren fehlgeschlagen.'
}
