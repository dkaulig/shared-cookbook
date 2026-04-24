import { useCallback, useMemo, useRef, useState } from 'react'
import { Link, Navigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  CalendarDays,
  Plus,
  RefreshCw,
  Repeat,
  ShoppingBasket,
  Sparkles,
  Trash2,
} from 'lucide-react'
import type {
  IngredientCategory,
  ShoppingListItemDto,
} from '@familien-kochbuch/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { SplitPane } from '@/components/layout/SplitPane'
import { useIsMobile } from '@/lib/useIsMobile'
import { cn } from '@/lib/utils'
import { useMealPlan } from '@/features/mealplanning/useMealPlan'
import {
  formatWeekRange,
  isMonday,
  isoWeekNumber,
  toMondayIso,
} from '@/features/mealplanning/weekGrid'
import { safeGetItem, safeSetItem } from '@/features/_shared/safeStorage'
import { ConfirmDialog } from '@/features/_shared/ConfirmDialog'
import {
  ConflictDialog,
  useConflictResolver,
} from '@/features/_shared/ConflictDialog'
import { VersionMismatchError } from '@/features/_shared/apiError'
import { toastMutationError } from '@/features/_shared/errorSurface'
import { useQueryClient } from '@tanstack/react-query'
import { AddItemDialog } from './AddItemDialog'
import { CATEGORY_LABELS } from './categoryLabels'
import { ItemConflictBody } from './ItemConflictBody'
import { ShoppingListApiError } from './shoppingListApi'
import {
  shoppingListQueryKeys,
  useDeleteShoppingListItem,
  useGenerateShoppingList,
  usePatchShoppingListItem,
  useShoppingList,
} from './useShoppingList'
import { byCategory, byName } from './shoppingListSort'

type SortMode = 'category' | 'name'

/**
 * P3-7 shopping-list page.
 *
 *   - Route: `/groups/:groupId/mealplan/:weekStart/shopping-list`.
 *   - Reads the meal-plan first (for the planId); the shopping list is
 *     fetched per-plan and the 404 "not generated yet" state shows a
 *     "Liste erzeugen" CTA.
 *   - Default view groups items by `IngredientCategory` using
 *     `byCategory`; a user-added sort toggle (§Architectural-decisions)
 *     flips to an alphabetic flat list via `byName`. The choice persists
 *     per-week in sessionStorage so reloads keep the user's view.
 *   - Check-off is optimistic via `usePatchShoppingListItem`.
 *   - Manual add via `AddItemDialog`; delete via the per-row trash
 *     button with a shared shadcn-style ConfirmDialog guard (plan-
 *     generated / carryover items re-appear on next regenerate, so the
 *     user should know before deleting — BUG-004).
 *   - Regenerate runs `POST …/shopping-list/generate` and prime the
 *     cache from the response.
 */
export function ShoppingListPage() {
  const params = useParams<{ groupId: string; weekStart: string }>()
  const groupId = params.groupId ?? ''
  const rawWeek = params.weekStart ?? ''

  const weekStart = useMemo(() => {
    if (!rawWeek) return ''
    try {
      return isMonday(rawWeek) ? rawWeek : toMondayIso(rawWeek)
    } catch {
      return ''
    }
  }, [rawWeek])

  if (!groupId) return <Navigate to="/groups" replace />
  if (!weekStart) {
    const today = new Date().toISOString().slice(0, 10)
    return (
      <Navigate
        to={`/groups/${groupId}/mealplan/${toMondayIso(today)}/shopping-list`}
        replace
      />
    )
  }
  if (rawWeek !== weekStart) {
    return (
      <Navigate
        to={`/groups/${groupId}/mealplan/${weekStart}/shopping-list`}
        replace
      />
    )
  }

  return (
    <ShoppingListView groupId={groupId} weekStart={weekStart} />
  )
}

function ShoppingListView({
  groupId,
  weekStart,
}: {
  groupId: string
  weekStart: string
}) {
  const {
    plan,
    notFound: planNotFound,
    isLoading: planLoading,
    isError: planError,
  } = useMealPlan(groupId, weekStart)
  const planId = plan?.id ?? ''

  const {
    list,
    notFound: listNotFound,
    isLoading: listLoading,
    isError: listError,
  } = useShoppingList(planId || undefined)

  const listId = list?.id ?? ''
  const generate = useGenerateShoppingList(planId)
  const patchItem = usePatchShoppingListItem(planId, listId)
  const deleteItem = useDeleteShoppingListItem(planId, listId)
  const queryClient = useQueryClient()

  // OFF4 — conflict resolver for item patches. Captures the last
  // dispatched patch so keep-local can re-dispatch with the server's
  // current version.
  const pendingPatchRef = useRef<
    | {
        itemId: string
        patch: import('@familien-kochbuch/shared').PatchShoppingListItemRequest
        local: ShoppingListItemDto
      }
    | null
  >(null)
  const conflict = useConflictResolver<ShoppingListItemDto & { version: number }>({
    onKeepLocal: async (expectedVersion) => {
      const pending = pendingPatchRef.current
      if (!pending) return
      await patchItem.mutateAsync({
        itemId: pending.itemId,
        patch: pending.patch,
        expectedVersion,
      })
    },
    onKeepServer: () => {
      void queryClient.invalidateQueries({
        queryKey: shoppingListQueryKeys.forPlan(planId),
      })
    },
  })

  const [sortMode, setSortMode] = useState<SortMode>(() =>
    readSortMode(groupId, weekStart),
  )
  const [showAdd, setShowAdd] = useState(false)
  // BUG-004 — the shopping-list row deletion used to fire `window.confirm`.
  // We now hold the pending row here so the shared ConfirmDialog can
  // present the same guardrail in-theme.
  const [pendingDelete, setPendingDelete] = useState<ShoppingListItemDto | null>(
    null,
  )
  // TABLET-2 — client-state selection (the spec explicitly allows
  // `useState` here since the shopping-list has no per-item URL). We
  // hold an id rather than the DTO so mutations (patch / delete) re-
  // resolve against the latest list snapshot on every render.
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)
  const isMobile = useIsMobile()

  const handleSortChange = useCallback(
    (next: SortMode) => {
      setSortMode(next)
      persistSortMode(groupId, weekStart, next)
    },
    [groupId, weekStart],
  )

  const handleToggleChecked = useCallback(
    (item: ShoppingListItemDto) => {
      if (!listId) return
      const patch = { isChecked: !item.isChecked }
      const localProjection: ShoppingListItemDto = { ...item, isChecked: !item.isChecked }
      pendingPatchRef.current = { itemId: item.id, patch, local: localProjection }
      patchItem.mutate(
        { itemId: item.id, patch },
        {
          onError: (err) => {
            if (err instanceof VersionMismatchError) {
              // 409 body is the full ShoppingListDto (OFF3). Extract
              // the matching item + stamp the list's version onto the
              // wrapper so the resolver's `T extends { version }`
              // constraint is happy without polluting the item DTO
              // shape.
              const list = err.current as
                | { version: number; items: ShoppingListItemDto[] }
                | null
              const serverItem = list?.items?.find((i) => i.id === item.id)
              if (!list || !serverItem) return
              conflict.captureFrom409(
                { ...localProjection, version: list.version },
                { current: { ...serverItem, version: list.version } },
              )
              return
            }
            // REL-5 — every non-409 failure (400 invalid_value, 500,
            // network) used to vanish silently. Route it through the
            // shared classifier so a toast surfaces. The optimistic
            // splice has already been rolled back by the hook.
            toastMutationError(err)
          },
        },
      )
    },
    [patchItem, listId, conflict],
  )

  const handleDelete = useCallback(
    (item: ShoppingListItemDto) => {
      if (!listId) return
      // BUG-004 — always confirm through the shared shadcn-style dialog.
      // Manual entries are user-typed and *more* precious than
      // plan-derived rows (which reappear on the next Neu-Erzeugen), so
      // the guardrail has to fire for every delete regardless of source.
      setPendingDelete(item)
    },
    [listId],
  )

  const handleConfirmDelete = useCallback(() => {
    if (!pendingDelete) return
    deleteItem.mutate(
      { itemId: pendingDelete.id },
      {
        onSettled: () => setPendingDelete(null),
        // REL-5 — toast on every failure (400/404/500). Prior to REL-5
        // the dialog simply closed on error and the row stayed in the
        // list with no explanation.
        onError: toastMutationError,
      },
    )
  }, [deleteItem, pendingDelete])

  const handleGenerate = useCallback(() => {
    if (!planId) return
    generate.mutate()
  }, [generate, planId])

  const totals = useMemo(() => {
    const items = list?.items ?? []
    const total = items.length
    const checked = items.filter((i) => i.isChecked).length
    return { total, checked }
  }, [list])

  const weekNumber = isoWeekNumber(weekStart)

  const selectedItem = useMemo(
    () =>
      selectedItemId
        ? list?.items.find((i) => i.id === selectedItemId) ?? null
        : null,
    [list, selectedItemId],
  )

  const listContent = (
    <div className="mx-auto w-full max-w-[1024px]">
      {/* Sticky page sub-nav.
          BUG-032: switched from hard-coded `top-[56px] z-20` to
          `top-[var(--topnav-height)] z-10`. Same reasoning as on
          MealPlanPage — sub-nav follows the shared TopNav token and
          the TopNav (z-20) clearly wins on any y-overlap. */}
      <nav
        className={cn(
          'sticky top-0 z-10 flex items-center gap-2.5 border-b border-border/60 px-4 py-2.5',
          'bg-[hsl(var(--background)/0.88)] backdrop-blur supports-[backdrop-filter]:bg-[hsl(var(--background)/0.75)]',
        )}
        aria-label="Einkaufsliste-Navigation"
      >
        <Link
          to={`/groups/${groupId}/mealplan/${weekStart}`}
          aria-label="Zurück zum Wochenplan"
          className="grid h-10 w-10 place-items-center rounded-[10px] text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--primary)/0.08)] hover:text-foreground"
        >
          <ArrowLeft className="h-[18px] w-[18px]" aria-hidden="true" />
        </Link>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <ShoppingBasket
            className="h-[18px] w-[18px] text-[hsl(var(--muted-foreground))]"
            aria-hidden="true"
          />
          <span className="truncate font-serif text-[18px] font-semibold tracking-[-0.005em]">
            Einkaufsliste
          </span>
        </div>
      </nav>

      <header className="flex flex-wrap items-center justify-between gap-3 px-5 pt-6 md:px-8">
        <div>
          <h1 className="font-serif text-[clamp(24px,4vw,32px)] font-semibold leading-tight">
            KW {weekNumber}
          </h1>
          <p className="text-sm text-muted-foreground">
            <CalendarDays
              className="mr-1 inline h-4 w-4 align-[-2px]"
              aria-hidden="true"
            />
            vom {formatWeekRange(weekStart)}
          </p>
        </div>
        {list && (
          <div className="inline-flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleGenerate}
              disabled={generate.isPending}
              aria-label="Einkaufsliste neu erzeugen"
            >
              <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden="true" />
              {generate.isPending ? 'Wird erzeugt …' : 'Neu erzeugen'}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => setShowAdd(true)}
            >
              <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" />
              Eintrag
            </Button>
          </div>
        )}
      </header>

      <main className="px-5 pb-10 pt-4 md:px-8">
        {(planLoading || listLoading) && (
          <div className="space-y-3">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-10 w-full rounded-md" />
            ))}
          </div>
        )}

        {planError && (
          <p
            role="alert"
            className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200"
          >
            Der Wochenplan konnte nicht geladen werden.
          </p>
        )}

        {planNotFound && (
          <div className="rounded-[18px] border border-dashed border-[hsl(var(--input))] bg-card/60 px-6 py-10 text-center">
            <p className="text-sm text-muted-foreground">
              Für diese Woche existiert noch kein Wochenplan.
            </p>
            <div className="mt-3">
              <Link
                to={`/groups/${groupId}/mealplan/${weekStart}`}
                className="text-sm font-medium text-primary underline-offset-4 hover:underline"
              >
                Zum Wochenplan
              </Link>
            </div>
          </div>
        )}

        {listError && (
          <p
            role="alert"
            className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200"
          >
            Die Einkaufsliste konnte nicht geladen werden.
          </p>
        )}

        {plan && listNotFound && (
          <EmptyListState
            onGenerate={handleGenerate}
            isPending={generate.isPending}
            errorMessage={
              generate.isError ? generateErrorMessage(generate.error) : null
            }
          />
        )}

        {list && (
          <>
            <ProgressHeader
              checked={totals.checked}
              total={totals.total}
            />
            <SortToggle mode={sortMode} onChange={handleSortChange} />
            {totals.total === 0 ? (
              <p className="mt-4 rounded-md border border-dashed border-input bg-card/60 px-4 py-6 text-center text-sm text-muted-foreground">
                Noch keine Einträge — lege welche über „Eintrag" an
                oder erzeuge die Liste neu.
              </p>
            ) : sortMode === 'category' ? (
              <CategoryList
                items={list.items}
                onToggle={handleToggleChecked}
                onDelete={handleDelete}
                onSelect={setSelectedItemId}
                selectedItemId={selectedItemId}
              />
            ) : (
              <AlphabeticList
                items={list.items}
                onToggle={handleToggleChecked}
                onDelete={handleDelete}
                onSelect={setSelectedItemId}
                selectedItemId={selectedItemId}
              />
            )}
          </>
        )}
      </main>
    </div>
  )

  const detailPane = selectedItem ? (
    <ItemDetail item={selectedItem} onClose={() => setSelectedItemId(null)} />
  ) : (
    <div
      className="flex h-full items-center justify-center px-6 py-10 text-center text-[hsl(var(--muted-foreground))]"
      role="status"
    >
      <p className="max-w-sm text-[15px] leading-[1.5]">
        Wähle einen Eintrag links, um Details zu sehen.
      </p>
    </div>
  )

  const body = isMobile ? (
    listContent
  ) : (
    <SplitPane
      leftLabel="Einkaufsliste"
      rightLabel="Eintrag-Detail"
      left={listContent}
      right={detailPane}
      className="h-full"
    />
  )

  return (
    <>
      {body}

      {showAdd && list && (
        <AddItemDialog
          planId={planId}
          listId={list.id}
          onClose={() => setShowAdd(false)}
        />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(null)
        }}
        title="Zutat wirklich löschen?"
        description={
          pendingDelete
            ? `"${pendingDelete.name}" wird aus der Liste entfernt. Plan-basierte Einträge tauchen erst beim nächsten "Neu erzeugen" wieder auf.`
            : ''
        }
        confirmLabel="Löschen"
        onConfirm={handleConfirmDelete}
        isLoading={deleteItem.isPending}
      />

      {conflict.state && (
        <ConflictDialog<ShoppingListItemDto & { version: number }>
          open={conflict.state.open}
          onClose={conflict.close}
          title="Konflikt in der Einkaufsliste"
          subtitle="Deine Änderungen konkurrieren mit einer Änderung vom Server. Wähle, welche Version gelten soll."
          currentServer={conflict.state.serverCurrent}
          localPending={conflict.state.localPending}
          renderDiff={({ current, local }) => (
            <ItemConflictBody current={current} local={local} />
          )}
          onKeepLocal={conflict.resolveKeepLocal}
          onKeepServer={conflict.resolveKeepServer}
          isLoading={patchItem.isPending}
        />
      )}
    </>
  )
}

function ProgressHeader({
  checked,
  total,
}: {
  checked: number
  total: number
}) {
  const pct = total === 0 ? 0 : Math.round((checked / total) * 100)
  const complete = total > 0 && checked === total
  return (
    <section
      aria-label="Fortschritt"
      className="mb-4 rounded-md border border-border bg-card/60 p-3"
    >
      <div className="mb-1.5 flex items-center justify-between text-sm">
        <span className="font-medium">
          {checked} von {total} abgehakt
        </span>
        {complete ? (
          <span className="inline-flex items-center gap-1 text-sm font-semibold text-primary">
            <Sparkles className="h-4 w-4" aria-hidden="true" />
            Einkauf komplett!
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">{pct}%</span>
        )}
      </div>
      <div
        role="progressbar"
        aria-valuenow={checked}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-label="Einkaufs-Fortschritt"
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width]"
          style={{ width: `${pct}%` }}
        />
      </div>
    </section>
  )
}

function SortToggle({
  mode,
  onChange,
}: {
  mode: SortMode
  onChange: (next: SortMode) => void
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Sortierung"
      className="mb-4 inline-flex rounded-md border border-border bg-card/60 p-1 text-sm"
    >
      <button
        type="button"
        role="radio"
        aria-checked={mode === 'category'}
        onClick={() => onChange('category')}
        className={cn(
          'rounded px-3 py-1.5 transition-colors',
          mode === 'category'
            ? 'bg-primary text-primary-foreground'
            : 'text-muted-foreground hover:text-foreground',
        )}
      >
        Nach Kategorie
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={mode === 'name'}
        onClick={() => onChange('name')}
        className={cn(
          'rounded px-3 py-1.5 transition-colors',
          mode === 'name'
            ? 'bg-primary text-primary-foreground'
            : 'text-muted-foreground hover:text-foreground',
        )}
      >
        Alphabetisch
      </button>
    </div>
  )
}

function CategoryList({
  items,
  onToggle,
  onDelete,
  onSelect,
  selectedItemId,
}: {
  items: readonly ShoppingListItemDto[]
  onToggle: (item: ShoppingListItemDto) => void
  onDelete: (item: ShoppingListItemDto) => void
  onSelect: (id: string) => void
  selectedItemId: string | null
}) {
  const buckets = useMemo(() => byCategory(items), [items])
  return (
    <div className="space-y-5">
      {buckets.map((bucket) => (
        <section
          key={bucket.category}
          aria-label={CATEGORY_LABELS[bucket.category]}
        >
          <h2 className="mb-2 font-serif text-[15px] font-semibold uppercase tracking-wide text-muted-foreground">
            {CATEGORY_LABELS[bucket.category]}
          </h2>
          <ul className="divide-y divide-border rounded-md border border-border bg-card/60">
            {bucket.items.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                onToggle={onToggle}
                onDelete={onDelete}
                onSelect={onSelect}
                isSelected={item.id === selectedItemId}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function AlphabeticList({
  items,
  onToggle,
  onDelete,
  onSelect,
  selectedItemId,
}: {
  items: readonly ShoppingListItemDto[]
  onToggle: (item: ShoppingListItemDto) => void
  onDelete: (item: ShoppingListItemDto) => void
  onSelect: (id: string) => void
  selectedItemId: string | null
}) {
  const sorted = useMemo(() => byName(items), [items])
  return (
    <ul className="divide-y divide-border rounded-md border border-border bg-card/60">
      {sorted.map((item) => (
        <ItemRow
          key={item.id}
          item={item}
          onToggle={onToggle}
          onDelete={onDelete}
          onSelect={onSelect}
          isSelected={item.id === selectedItemId}
          showCategoryChip
        />
      ))}
    </ul>
  )
}

function ItemRow({
  item,
  onToggle,
  onDelete,
  onSelect,
  isSelected = false,
  showCategoryChip = false,
}: {
  item: ShoppingListItemDto
  onToggle: (item: ShoppingListItemDto) => void
  onDelete: (item: ShoppingListItemDto) => void
  onSelect?: (id: string) => void
  isSelected?: boolean
  showCategoryChip?: boolean
}) {
  const qtyLabel = formatQuantity(item.quantity, item.unit)
  return (
    <li
      className={cn(
        'flex items-center gap-3 px-3 py-2.5 transition-colors',
        // TABLET-2 — at md:+ the row's middle section becomes the
        // select-affordance for the detail slot. We don't hit-area the
        // whole <li> because the checkbox + trash buttons live on the
        // left / right and need their own clicks.
        isSelected && 'bg-[hsl(var(--primary)/0.08)]',
      )}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={item.isChecked}
        aria-label={`${item.name} ${item.isChecked ? 'abhaken rückgängig' : 'abhaken'}`}
        onClick={() => onToggle(item)}
        // P3-10: 44×44 px tap target around a 20×20 px visual checkbox.
        // The outer button is the hit-area; the inner `<span>` carries
        // the styled-box look so finger users don't have to aim at a
        // 20-px square.
        className="grid min-h-[44px] min-w-[44px] shrink-0 place-items-center rounded transition-colors"
      >
        <span
          aria-hidden="true"
          className={cn(
            'grid h-5 w-5 place-items-center rounded border transition-colors',
            item.isChecked
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-input bg-background hover:border-primary/60',
          )}
        >
          {item.isChecked && (
            <svg
              viewBox="0 0 24 24"
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth={3}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
        </span>
      </button>

      <button
        type="button"
        onClick={() => onSelect?.(item.id)}
        aria-pressed={isSelected}
        aria-label={`Details zu ${item.name}`}
        className="block min-w-0 flex-1 cursor-pointer rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span
            className={cn(
              'truncate text-sm',
              item.isChecked && 'text-muted-foreground line-through',
            )}
          >
            {item.name}
          </span>
          {qtyLabel && (
            <span className="text-xs text-muted-foreground">{qtyLabel}</span>
          )}
          {item.carriedOverFromPreviousWeek && (
            <span
              className="inline-flex items-center gap-0.5 text-[hsl(var(--muted-foreground))]"
              title="Aus letzter Woche übernommen"
              aria-label="Aus letzter Woche übernommen"
            >
              <Repeat className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
          )}
          {showCategoryChip && (
            <Badge variant="mini">{CATEGORY_LABELS[item.category]}</Badge>
          )}
        </span>
        {item.note && (
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {item.note}
          </span>
        )}
      </button>

      <button
        type="button"
        onClick={() => onDelete(item)}
        aria-label={`${item.name} entfernen`}
        // P3-10: ≥44×44 mobile tap target.
        className="grid min-h-[44px] min-w-[44px] shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-red-50 hover:text-red-700"
      >
        <Trash2 className="h-4 w-4" aria-hidden="true" />
      </button>
    </li>
  )
}

/**
 * TABLET-2 — read-only detail card for the currently-selected shopping-
 * list item. Populates the SplitPane's right column at md:+. Check-off
 * + delete still happen on the row (left pane) so the detail stays a
 * summary surface.
 */
function ItemDetail({
  item,
  onClose,
}: {
  item: ShoppingListItemDto
  onClose: () => void
}) {
  const qtyLabel = formatQuantity(item.quantity, item.unit)
  return (
    <article
      aria-label={`Detail: ${item.name}`}
      className="mx-auto w-full max-w-lg px-5 py-6 md:px-8 md:py-8"
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {CATEGORY_LABELS[item.category]}
          </p>
          <h2
            className={cn(
              'mt-1 font-serif text-[clamp(22px,3vw,28px)] font-semibold leading-tight text-foreground',
              item.isChecked && 'text-muted-foreground line-through',
            )}
          >
            {item.name}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Detail schließen"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--primary)/0.08)] hover:text-foreground"
        >
          ×
        </button>
      </header>

      <dl className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {qtyLabel && (
          <div className="rounded-[14px] border border-border bg-card/60 px-4 py-3">
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Menge
            </dt>
            <dd className="mt-1 text-lg font-semibold text-foreground">
              {qtyLabel}
            </dd>
          </div>
        )}
        <div className="rounded-[14px] border border-border bg-card/60 px-4 py-3">
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Status
          </dt>
          <dd className="mt-1 text-sm font-medium text-foreground">
            {item.isChecked ? 'Abgehakt' : 'Offen'}
          </dd>
        </div>
        <div className="rounded-[14px] border border-border bg-card/60 px-4 py-3">
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Quelle
          </dt>
          <dd className="mt-1 text-sm text-foreground">
            {item.source === 'Manual' ? 'Manuell hinzugefügt' : 'Aus Wochenplan'}
          </dd>
        </div>
        {item.carriedOverFromPreviousWeek && (
          <div className="rounded-[14px] border border-border bg-card/60 px-4 py-3">
            <dt className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <Repeat className="h-3.5 w-3.5" aria-hidden="true" />
              Übernommen
            </dt>
            <dd className="mt-1 text-sm text-foreground">
              Aus letzter Woche
            </dd>
          </div>
        )}
      </dl>

      {item.note && (
        <section className="mt-5">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Notiz
          </h3>
          <p className="mt-1 whitespace-pre-wrap rounded-[12px] border border-border bg-card/60 px-4 py-3 text-sm text-foreground">
            {item.note}
          </p>
        </section>
      )}

      <p className="mt-6 text-xs text-muted-foreground">
        Abhaken oder Entfernen über die Zeile links.
      </p>
    </article>
  )
}

function EmptyListState({
  onGenerate,
  isPending,
  errorMessage,
}: {
  onGenerate: () => void
  isPending: boolean
  errorMessage: string | null
}) {
  return (
    <div className="rounded-[18px] border border-dashed border-[hsl(var(--input))] bg-card/60 px-6 py-10 text-center">
      <ShoppingBasket
        className="mx-auto mb-3 h-8 w-8 text-muted-foreground"
        aria-hidden="true"
      />
      <h2 className="font-serif text-[22px] font-semibold text-foreground">
        Noch keine Einkaufsliste
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Lass die Liste aus deinem Wochenplan erzeugen — Zutaten werden nach
        Kategorie sortiert.
      </p>
      <div className="mt-4">
        <Button type="button" onClick={onGenerate} disabled={isPending}>
          {isPending ? 'Wird erzeugt …' : 'Liste erzeugen'}
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
 * Error copy for the "Liste erzeugen" CTA. 429 is surfaced distinctly so
 * the user understands they just need to wait — the generic error copy
 * would prompt a fruitless retry loop. Every other failure falls back
 * to the generic German message.
 */
function generateErrorMessage(error: Error | null): string {
  if (error instanceof ShoppingListApiError && error.status === 429) {
    return 'Zu viele Anfragen — bitte kurz warten, bevor du die Liste erneut erzeugst.'
  }
  return 'Liste konnte nicht erzeugt werden.'
}

function formatQuantity(
  quantity: string | null,
  unit: string | null,
): string | null {
  const q = quantity?.trim() ?? ''
  const u = unit?.trim() ?? ''
  if (!q && !u) return null
  if (q && u) return `${q} ${u}`
  return q || u
}

// ── session-storage helpers ───────────────────────────────────────

function sortStorageKey(groupId: string, weekStart: string): string {
  return `shopping-sort-${groupId}-${weekStart}`
}

function readSortMode(groupId: string, weekStart: string): SortMode {
  // Private-mode Safari throws on sessionStorage access — `safeGetItem`
  // swallows that and returns `null`, so we default to the category view.
  const raw = safeGetItem(sortStorageKey(groupId, weekStart))
  return raw === 'name' ? 'name' : 'category'
}

function persistSortMode(
  groupId: string,
  weekStart: string,
  mode: SortMode,
): void {
  safeSetItem(sortStorageKey(groupId, weekStart), mode)
}

/**
 * Re-exported so `IngredientCategory` can be inferred at the call-site
 * of the category-chip helper without pulling in the full shared types
 * tree at the import stage.
 */
export type ShoppingListCategory = IngredientCategory
