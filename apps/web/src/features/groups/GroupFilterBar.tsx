import { Dices, Search, SlidersHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * DS4 filter bar — pure presentational component.
 *
 * Mirrors `.filter-bar` in
 * `docs/mockups/warme-kueche-group-detail.html`:
 *   1. Search input (flex-1) with leading magnifier icon.
 *   2. "Filter (N)" toggle button — reveals the expanded filter panel.
 *   3. "Zufall" destructive-variant button — picks a random recipe.
 *
 * All state is lifted via props so the parent can own URL-param state
 * (debounced search, filter open/closed, random-pick pending flag).
 */
export interface GroupFilterBarProps {
  searchQuery: string
  onSearchChange: (next: string) => void
  activeFilterCount: number
  isFilterOpen: boolean
  onToggleFilter: () => void
  onRandomPick: () => void
  isRandomPending: boolean
}

export function GroupFilterBar({
  searchQuery,
  onSearchChange,
  activeFilterCount,
  isFilterOpen,
  onToggleFilter,
  onRandomPick,
  isRandomPending,
}: GroupFilterBarProps) {
  return (
    <div className="flex items-stretch gap-2.5">
      {/* Search field — `min-w-0` is REQUIRED on this flex item: without it
          the input's intrinsic placeholder width forces the row wider than
          the parent, pushing the Filter + Zufall buttons off-screen on
          narrow viewports (BUG-006). With `min-w-0`, `flex-1` can shrink
          below its content width and the buttons stay inside the viewport. */}
      <label
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 rounded-[12px] border border-[hsl(var(--input))] bg-card px-3.5',
          'transition-[border-color,box-shadow] duration-150',
          'focus-within:border-primary focus-within:ring-4 focus-within:ring-[hsl(var(--primary)/0.25)]',
        )}
      >
        <Search
          aria-hidden="true"
          className="h-[17px] w-[17px] shrink-0 text-[hsl(var(--muted-foreground))]"
        />
        <span className="sr-only">Suche</span>
        <input
          type="search"
          aria-label="Suche"
          placeholder="Rezept oder Zutat suchen…"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          className="flex-1 border-0 bg-transparent py-2.5 text-base text-foreground outline-none placeholder:text-[hsl(var(--muted-foreground))]"
        />
      </label>

      {/* Filter-panel toggle */}
      <button
        type="button"
        onClick={onToggleFilter}
        aria-expanded={isFilterOpen}
        className={cn(
          'inline-flex items-center justify-center gap-1.5 rounded-[12px] px-3.5 py-2.5',
          'border border-[hsl(var(--input))] bg-card text-sm font-semibold text-foreground',
          'transition-colors hover:border-primary hover:text-primary',
          'focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[hsl(var(--primary)/0.25)]',
        )}
      >
        <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
        Filter
        {activeFilterCount > 0 && (
          <span className="rounded-full bg-primary px-[7px] py-[1px] text-[11px] font-semibold text-primary-foreground">
            {activeFilterCount}
          </span>
        )}
      </button>

      {/* Zufall button */}
      <button
        type="button"
        onClick={onRandomPick}
        disabled={isRandomPending}
        title="Zufälliges Rezept"
        className={cn(
          'inline-flex items-center justify-center gap-1.5 rounded-[12px] px-3.5 py-2.5',
          'border border-destructive bg-destructive text-sm font-semibold text-destructive-foreground',
          'shadow-[0_3px_12px_-4px_rgba(220,38,38,0.5)]',
          'transition-[background-color,transform] duration-150 hover:bg-[#b91c1c] active:scale-[0.98]',
          'disabled:cursor-not-allowed disabled:opacity-70',
          'focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[hsl(var(--destructive)/0.3)]',
        )}
      >
        <Dices className="h-4 w-4" aria-hidden="true" />
        {isRandomPending ? 'Würfle…' : 'Zufall'}
      </button>
    </div>
  )
}
