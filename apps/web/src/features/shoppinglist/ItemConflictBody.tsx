import type { ShoppingListItemDto } from '@familien-kochbuch/shared'
import { CATEGORY_LABELS } from './categoryLabels'

/**
 * OFF4 — shopping-list-item-scoped diff body for `<ConflictDialog />`.
 *
 * Items have few fields (name, quantity, unit, category, isChecked,
 * note) and the typical conflict is a toggle or note edit. Two-button
 * flow — no manual-merge path.
 */
export function ItemConflictBody({
  current,
  local,
}: {
  current: ShoppingListItemDto
  local: ShoppingListItemDto
}) {
  return (
    <div className="space-y-3" data-testid="item-conflict-body">
      <Row label="Name" server={current.name} local={local.name} />
      <Row
        label="Menge"
        server={current.quantity ?? '—'}
        local={local.quantity ?? '—'}
      />
      <Row
        label="Einheit"
        server={current.unit ?? '—'}
        local={local.unit ?? '—'}
      />
      <Row
        label="Kategorie"
        server={CATEGORY_LABELS[current.category]}
        local={CATEGORY_LABELS[local.category]}
      />
      <Row
        label="Abgehakt"
        server={current.isChecked ? 'Ja' : 'Nein'}
        local={local.isChecked ? 'Ja' : 'Nein'}
      />
      <Row
        label="Notiz"
        server={current.note ?? '—'}
        local={local.note ?? '—'}
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
