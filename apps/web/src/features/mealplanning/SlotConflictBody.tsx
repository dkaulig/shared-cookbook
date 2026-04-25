import type { MealPlanSlotDto } from '@shared-cookbook/shared'
import { MEAL_SLOT_LABELS, formatGermanDate } from './weekGrid'

/**
 * OFF4 — slot-scoped diff body for `<ConflictDialog />`.
 *
 * Slots have few fields that commonly conflict (meal bucket, servings,
 * cooked-toggle, recipe label), so we render every field side-by-side.
 * No manual-merge editor — two-button flow is plenty.
 */
export function SlotConflictBody({
  current,
  local,
}: {
  current: MealPlanSlotDto
  local: MealPlanSlotDto
}) {
  return (
    <div className="space-y-3" data-testid="slot-conflict-body">
      <Row
        label="Datum"
        server={formatGermanDate(current.date)}
        local={formatGermanDate(local.date)}
      />
      <Row
        label="Mahlzeit"
        server={MEAL_SLOT_LABELS[current.meal]}
        local={MEAL_SLOT_LABELS[local.meal]}
      />
      <Row
        label="Rezept / Titel"
        server={current.label ?? (current.recipeId ?? '—')}
        local={local.label ?? (local.recipeId ?? '—')}
      />
      <Row
        label="Portionen"
        server={String(current.servings)}
        local={String(local.servings)}
      />
      <Row
        label="Gekocht"
        server={current.isCooked ? 'Ja' : 'Nein'}
        local={local.isCooked ? 'Ja' : 'Nein'}
      />
    </div>
  )
}

function Row({
  label,
  server,
  local,
}: {
  label: string
  server: string
  local: string
}) {
  const same = server === local
  return (
    <section>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </h3>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Side kind="server" text={server} highlight={!same} />
        <Side kind="local" text={local} highlight={!same} />
      </div>
    </section>
  )
}

function Side({
  kind,
  text,
  highlight,
}: {
  kind: 'server' | 'local'
  text: string
  highlight: boolean
}) {
  const label = kind === 'server' ? 'Server' : 'Lokal'
  return (
    <div
      data-testid={`conflict-side-${kind}`}
      className={
        'rounded-md border px-2 py-1.5 text-sm ' +
        (highlight
          ? 'border-amber-300 bg-amber-50 text-amber-900'
          : 'border-border bg-card/60 text-foreground')
      }
    >
      <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="whitespace-pre-wrap break-words">{text}</p>
    </div>
  )
}
