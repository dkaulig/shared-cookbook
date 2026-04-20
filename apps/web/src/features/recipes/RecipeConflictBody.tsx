import { useState } from 'react'
import type { RecipeDetailDto } from '@familien-kochbuch/shared'

/**
 * OFF4 — Recipe-scoped diff body for `<ConflictDialog />`.
 *
 * Design trade-off (plan §4a): a full text-diff across ingredient /
 * step content is too heavy for a kitchen-side dialog, so we show
 * field-level summaries:
 *   - title + description: full-text preview side-by-side.
 *   - ingredients: count delta (e.g. "3 → 5 Zutaten").
 *   - steps: count delta + how many positions differ.
 *
 * The optional "Manuell zusammenführen" editor exposes editable
 * `title` / `description` text fields pre-filled with the LOCAL side —
 * the user can freely mutate them and the parent dialog's
 * `onManualMerge` fires with the edited payload. Ingredient + step
 * lists are not editable in this first pass (their structure is rich
 * enough that a proper merge UI is a dedicated polish slice); the
 * user keeps the local ingredient / step arrays when they choose the
 * manual-merge path.
 */
export type RecipeConflictShape = Pick<
  RecipeDetailDto,
  'id' | 'title' | 'description' | 'ingredients' | 'steps' | 'version'
>

export function RecipeConflictBody({
  current,
  local,
  mergeEditorOpen = false,
  onMergeChange,
}: {
  current: RecipeConflictShape
  local: RecipeConflictShape
  /**
   * Recipe manual-merge editor visibility. The parent dialog doesn't
   * know about this field — it's purely internal state the body owns.
   * We also expose `onMergeChange` so the dialog can stash the edited
   * values if needed.
   */
  mergeEditorOpen?: boolean
  onMergeChange?: (merged: RecipeConflictShape) => void
}) {
  const [editedTitle, setEditedTitle] = useState(local.title)
  const [editedDescription, setEditedDescription] = useState(
    local.description ?? '',
  )

  // Step-level diff heuristic: count steps whose content at the same
  // position differs. Positions only present on one side also count as
  // "changed". Purely informational — no full text-diff rendered.
  const changedStepCount = countChangedSteps(current.steps, local.steps)

  function handleMergeFieldChange(
    next: Partial<Pick<RecipeConflictShape, 'title' | 'description'>>,
  ) {
    const merged: RecipeConflictShape = {
      ...local,
      title: next.title ?? editedTitle,
      description:
        next.description !== undefined
          ? next.description
          : editedDescription || null,
    }
    onMergeChange?.(merged)
  }

  return (
    <div className="space-y-4" data-testid="recipe-conflict-body">
      <FieldRow label="Titel">
        <SideBySide server={current.title} local={local.title} />
      </FieldRow>

      <FieldRow label="Beschreibung">
        <SideBySide
          server={current.description ?? ''}
          local={local.description ?? ''}
        />
      </FieldRow>

      <FieldRow label="Zutaten">
        <p className="text-sm">
          <span className="font-medium">{current.ingredients.length}</span>
          {' → '}
          <span className="font-medium">{local.ingredients.length}</span>{' '}
          Zutaten
        </p>
      </FieldRow>

      <FieldRow label="Schritte">
        <p className="text-sm">
          <span className="font-medium">{current.steps.length}</span>
          {' → '}
          <span className="font-medium">{local.steps.length}</span> Schritte
          {changedStepCount > 0 && (
            <>
              {' · '}
              <span className="text-[hsl(var(--muted-foreground))]">
                {changedStepCount} geänderte Schritt
                {changedStepCount === 1 ? '' : 'e'}
              </span>
            </>
          )}
        </p>
      </FieldRow>

      {mergeEditorOpen && (
        <div
          className="rounded-md border border-border bg-card/60 p-3"
          data-testid="recipe-conflict-merge-editor"
        >
          <p className="mb-2 text-xs text-muted-foreground">
            Passe die Felder an und übernimm die zusammengeführte Version.
          </p>
          <label className="block space-y-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">
              Titel (zusammengeführt)
            </span>
            <input
              type="text"
              className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
              value={editedTitle}
              onChange={(e) => {
                setEditedTitle(e.target.value)
                handleMergeFieldChange({ title: e.target.value })
              }}
              data-testid="recipe-conflict-merge-title"
            />
          </label>
          <label className="mt-2 block space-y-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">
              Beschreibung (zusammengeführt)
            </span>
            <textarea
              className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
              rows={3}
              value={editedDescription}
              onChange={(e) => {
                setEditedDescription(e.target.value)
                handleMergeFieldChange({ description: e.target.value })
              }}
              data-testid="recipe-conflict-merge-description"
            />
          </label>
        </div>
      )}
    </div>
  )
}

function FieldRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <section>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </h3>
      {children}
    </section>
  )
}

function SideBySide({ server, local }: { server: string; local: string }) {
  const same = server === local
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      <SideBox kind="server" text={server} highlight={!same} />
      <SideBox kind="local" text={local} highlight={!same} />
    </div>
  )
}

function SideBox({
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
      <p className="whitespace-pre-wrap break-words">{text || '—'}</p>
    </div>
  )
}

function countChangedSteps(
  serverSteps: readonly { position: number; content: string }[],
  localSteps: readonly { position: number; content: string }[],
): number {
  const max = Math.max(serverSteps.length, localSteps.length)
  let changed = 0
  for (let i = 0; i < max; i++) {
    const s = serverSteps[i]
    const l = localSteps[i]
    if (!s || !l || s.content !== l.content || s.position !== l.position) {
      changed++
    }
  }
  return changed
}
