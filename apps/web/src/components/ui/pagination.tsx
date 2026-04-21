import { ChevronLeft, ChevronRight, MoreHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'
import { buildPageList } from './pagination-helpers'

/**
 * Lightweight Pagination primitive modelled on shadcn/ui's <Pagination />
 * (https://ui.shadcn.com/docs/components/pagination) without pulling the
 * CLI dependency in — we only need numbered pages + prev/next arrows for
 * the recipe-list, so hand-rolling keeps the bundle tight.
 *
 * Contract:
 *   - `page` / `totalPages` are 1-based.
 *   - `onPageChange(nextPage)` fires when the user clicks a numbered
 *     button or the arrows. Callers are responsible for writing the
 *     chosen page to the URL (see GroupDetailPage).
 *   - Mobile (`< md`) renders a compact `← 3 / 12 →` summary.
 *   - Desktop/tablet (`md:+`) renders numbered pages with an ellipsis
 *     elision when there are more than ~7 total pages.
 *   - Hidden entirely when `totalPages <= 1` — one-page lists get no
 *     nav chrome.
 */
export interface PaginationProps {
  page: number
  totalPages: number
  onPageChange: (nextPage: number) => void
  /** Optional aria-label for the <nav>. Defaults to "Seitennavigation". */
  label?: string
}

export function Pagination({
  page,
  totalPages,
  onPageChange,
  label = 'Seitennavigation',
}: PaginationProps) {
  if (totalPages <= 1) return null
  const safePage = Math.min(Math.max(1, page), totalPages)
  const canPrev = safePage > 1
  const canNext = safePage < totalPages

  return (
    <nav
      aria-label={label}
      className="flex items-center justify-center gap-1.5 py-3"
    >
      {/* Previous arrow — always rendered, disabled on page 1. */}
      <button
        type="button"
        onClick={() => canPrev && onPageChange(safePage - 1)}
        disabled={!canPrev}
        aria-label="Vorherige Seite"
        className={cn(
          'inline-flex h-9 items-center gap-1 rounded-md border border-input bg-background px-2.5 text-sm font-medium text-foreground transition-colors',
          'hover:bg-[hsl(var(--primary)/0.08)]',
          'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-background',
        )}
      >
        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        <span className="hidden md:inline">Zurück</span>
      </button>

      {/* Mobile: compact "N / M" indicator. */}
      <span
        aria-live="polite"
        className="px-2 text-sm font-medium tabular-nums text-foreground md:hidden"
      >
        {safePage} / {totalPages}
      </span>

      {/* Desktop: numbered pages. */}
      <ol className="hidden items-center gap-1 md:flex">
        {buildPageList(safePage, totalPages).map((entry, i) => {
          if (entry === 'ellipsis') {
            return (
              <li key={`e-${i}`} aria-hidden="true" className="px-1">
                <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
              </li>
            )
          }
          const isCurrent = entry === safePage
          return (
            <li key={entry}>
              <button
                type="button"
                onClick={() => !isCurrent && onPageChange(entry)}
                aria-current={isCurrent ? 'page' : undefined}
                aria-label={`Seite ${entry}`}
                className={cn(
                  'inline-flex h-9 min-w-9 items-center justify-center rounded-md px-2 text-sm font-medium tabular-nums transition-colors',
                  isCurrent
                    ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]'
                    : 'border border-input bg-background text-foreground hover:bg-[hsl(var(--primary)/0.08)]',
                )}
              >
                {entry}
              </button>
            </li>
          )
        })}
      </ol>

      <button
        type="button"
        onClick={() => canNext && onPageChange(safePage + 1)}
        disabled={!canNext}
        aria-label="Nächste Seite"
        className={cn(
          'inline-flex h-9 items-center gap-1 rounded-md border border-input bg-background px-2.5 text-sm font-medium text-foreground transition-colors',
          'hover:bg-[hsl(var(--primary)/0.08)]',
          'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-background',
        )}
      >
        <span className="hidden md:inline">Weiter</span>
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </button>
    </nav>
  )
}

