import { useState } from 'react'
import type { RecipeChangeType, RecipeSnapshot } from '@familien-kochbuch/shared'
import { Button } from '@/components/ui/button'
import { useRecipeRevision, useRecipeRevisions } from './hooks'
import { formatRelativeDe } from './relativeTime'
import { RecipeRevisionDiffModal } from './RecipeRevisionDiffModal'

interface RecipeHistoryPanelProps {
  recipeId: string
  /** Snapshot-shaped representation of the live recipe — the modal renders
   *  the selected revision against this so users can see what changed. */
  current: RecipeSnapshot
}

const CHANGE_TYPE_LABEL: Record<RecipeChangeType, string> = {
  Created: 'Angelegt',
  Edited: 'Bearbeitet',
  Forked: 'Geforkt',
}

const CHANGE_TYPE_BADGE: Record<RecipeChangeType, string> = {
  Created: 'bg-emerald-100 text-emerald-800',
  Edited: 'bg-sky-100 text-sky-800',
  Forked: 'bg-violet-100 text-violet-800',
}

/**
 * S6 "Letzte Änderungen" panel — collapsible card on the recipe detail
 * page. Shows up to five revisions newest-first; clicking a row opens
 * the diff modal against the current recipe state.
 */
export function RecipeHistoryPanel({ recipeId, current }: RecipeHistoryPanelProps) {
  const [open, setOpen] = useState(false)
  const [activeRevisionId, setActiveRevisionId] = useState<string | null>(null)
  const revisions = useRecipeRevisions(recipeId)

  const items = revisions.data ?? []

  return (
    <section className="mt-8 rounded-md bg-background p-4 ring-1 ring-border">
      <header className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-stone-900">Letzte Änderungen</h2>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setOpen((prev) => !prev)}
          aria-expanded={open}
        >
          {open ? 'Einklappen' : `Anzeigen (${items.length})`}
        </Button>
      </header>

      {open && (
        <div className="mt-4">
          {revisions.isLoading && (
            <p className="text-sm text-stone-500">Lade Änderungen …</p>
          )}
          {revisions.isError && (
            <p role="alert" className="text-sm text-red-700">
              Änderungen konnten nicht geladen werden.
            </p>
          )}
          {!revisions.isLoading && !revisions.isError && items.length === 0 && (
            <p className="text-sm text-stone-500">Noch keine Änderungen erfasst.</p>
          )}
          <ul className="space-y-2">
            {items.map((rev) => (
              <li key={rev.id}>
                <button
                  type="button"
                  onClick={() => setActiveRevisionId(rev.id)}
                  className="flex w-full flex-col gap-1 rounded-md border border-stone-200 px-3 py-2 text-left text-sm hover:bg-stone-50"
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-medium text-stone-900">{rev.changedBy.displayName}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${CHANGE_TYPE_BADGE[rev.changeType]}`}
                    >
                      {CHANGE_TYPE_LABEL[rev.changeType]}
                    </span>
                  </span>
                  <span className="text-xs text-stone-500">
                    {formatRelativeDe(rev.createdAt)}
                  </span>
                  {rev.diffSummary && (
                    <span className="text-sm text-stone-700">{rev.diffSummary}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!open && items.length > 0 && (
        // Keep summaries clickable even when the panel is collapsed — the
        // header chip already shows the count, but we expose the latest
        // entry inline so the most relevant info is one tap away.
        <ul className="mt-3 space-y-2">
          {items.slice(0, 1).map((rev) => (
            <li key={rev.id}>
              <button
                type="button"
                onClick={() => setActiveRevisionId(rev.id)}
                className="flex w-full flex-col gap-1 rounded-md border border-stone-200 px-3 py-2 text-left text-sm hover:bg-stone-50"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="font-medium text-stone-900">{rev.changedBy.displayName}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs ${CHANGE_TYPE_BADGE[rev.changeType]}`}
                  >
                    {CHANGE_TYPE_LABEL[rev.changeType]}
                  </span>
                </span>
                <span className="text-xs text-stone-500">
                  {formatRelativeDe(rev.createdAt)}
                </span>
                {rev.diffSummary && (
                  <span className="text-sm text-stone-700">{rev.diffSummary}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {activeRevisionId && (
        <RevisionModalLoader
          recipeId={recipeId}
          revisionId={activeRevisionId}
          current={current}
          onClose={() => setActiveRevisionId(null)}
        />
      )}
    </section>
  )
}

interface LoaderProps {
  recipeId: string
  revisionId: string
  current: RecipeSnapshot
  onClose: () => void
}

/**
 * Tiny indirection so we can call the per-revision query hook
 * conditionally without bending the rules on hooks ordering: this
 * subcomponent only mounts when a row was clicked, so the hook fires
 * exactly once for the chosen revision.
 */
function RevisionModalLoader({ recipeId, revisionId, current, onClose }: LoaderProps) {
  const detail = useRecipeRevision(recipeId, revisionId)
  if (!detail.data) return null
  return (
    <RecipeRevisionDiffModal
      previous={detail.data}
      current={current}
      onClose={onClose}
    />
  )
}
