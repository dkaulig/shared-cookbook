import { useState } from 'react'
import { ChevronDown, GitFork, Pencil, Sparkles } from 'lucide-react'
import type { RecipeChangeType, RecipeSnapshot } from '@shared-cookbook/shared'
import { cn } from '@/lib/utils'
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

/**
 * DS5 "Letzte Änderungen" card (S6 logic, restyled shell). The revision
 * list + diff-modal plumbing is unchanged; only the surrounding visual
 * grammar moves to match `.history-card` in
 * `docs/mockups/warme-kueche-recipe-detail.html`:
 *
 *   - collapsible card with a hoverable header row (chevron rotates 180°)
 *   - change-type icons colored by type (Created=green, Edited=amber,
 *     Forked=purple)
 *   - rows are inline grid: 28px icon · 1fr body · auto relative-time
 */
export function RecipeHistoryPanel({ recipeId, current }: RecipeHistoryPanelProps) {
  const [open, setOpen] = useState(false)
  const [activeRevisionId, setActiveRevisionId] = useState<string | null>(null)
  const revisions = useRecipeRevisions(recipeId)

  const items = revisions.data ?? []

  return (
    <section className="overflow-hidden rounded-[18px] border border-border bg-card shadow-[0_1px_2px_rgba(28,25,23,0.04)]">
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? 'Einklappen' : `Anzeigen (${items.length})`}
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center justify-between px-5 py-3.5 text-left transition-colors hover:bg-[hsl(var(--muted))]"
      >
        <div className="flex items-center gap-2.5">
          <h3 className="font-serif text-[18px] font-semibold leading-none text-foreground">
            Letzte Änderungen
          </h3>
          <span className="rounded-full bg-[hsl(var(--secondary))] px-[7px] py-[2px] text-[11px] font-semibold text-[hsl(var(--primary))]">
            {items.length}
          </span>
        </div>
        <ChevronDown
          className={cn(
            'h-[18px] w-[18px] text-[hsl(var(--muted-foreground))] transition-transform duration-200',
            open && 'rotate-180',
          )}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div className="border-t border-[hsl(var(--border)/0.55)] py-1.5">
          {revisions.isLoading && (
            <p className="px-5 py-3 text-[13px] text-[hsl(var(--muted-foreground))]">
              Lade Änderungen …
            </p>
          )}
          {revisions.isError && (
            <p
              role="alert"
              className="px-5 py-3 text-[13px] text-[hsl(var(--destructive))]"
            >
              Änderungen konnten nicht geladen werden.
            </p>
          )}
          {!revisions.isLoading && !revisions.isError && items.length === 0 && (
            <p className="px-5 py-3 text-[13px] text-[hsl(var(--muted-foreground))]">
              Noch keine Änderungen erfasst.
            </p>
          )}
          <ul>
            {items.map((rev, index) => (
              <li
                key={rev.id}
                className={cn(
                  'px-5',
                  index > 0 && 'border-t border-[hsl(var(--border)/0.55)]',
                )}
              >
                <button
                  type="button"
                  onClick={() => setActiveRevisionId(rev.id)}
                  aria-label={`${CHANGE_TYPE_LABEL[rev.changeType]} – ${rev.changedBy.displayName}`}
                  className="grid w-full grid-cols-[28px_1fr_auto] items-center gap-3 py-2.5 text-left text-[13px]"
                >
                  <ChangeIcon changeType={rev.changeType} />
                  <div className="leading-[1.4]">
                    <div className="text-foreground">
                      <strong className="font-semibold">
                        {rev.changedBy.displayName}
                      </strong>{' '}
                      · {CHANGE_TYPE_LABEL[rev.changeType]}
                    </div>
                    {rev.diffSummary && (
                      <div className="text-[12px] text-[hsl(var(--muted-foreground))]">
                        {rev.diffSummary}
                      </div>
                    )}
                  </div>
                  <div className="whitespace-nowrap text-[12px] text-[hsl(var(--muted-foreground))]">
                    {formatRelativeDe(rev.createdAt)}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
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

function ChangeIcon({ changeType }: { changeType: RecipeChangeType }) {
  const styles: Record<RecipeChangeType, { bg: string; fg: string }> = {
    Created: { bg: 'bg-[hsl(142_71%_90%)]', fg: 'text-[hsl(142_71%_29%)]' },
    Edited: {
      bg: 'bg-[hsl(var(--secondary))]',
      fg: 'text-[hsl(var(--primary))]',
    },
    Forked: { bg: 'bg-[hsl(260_89%_94%)]', fg: 'text-[hsl(262_83%_53%)]' },
  }
  const Icon = changeType === 'Forked'
    ? GitFork
    : changeType === 'Created'
      ? Sparkles
      : Pencil
  const style = styles[changeType]
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid h-7 w-7 flex-shrink-0 place-items-center rounded-full',
        style.bg,
        style.fg,
      )}
    >
      <Icon className="h-[14px] w-[14px]" strokeWidth={2} />
    </span>
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
