import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * TABLET-1 — two-column split-view primitive for tablet/desktop pages.
 *
 * Lives INSIDE `<main>` (the hoppr-style scroll container owned by
 * `<AppLayout>`). At the `md:` breakpoint (768 px) the pane switches to
 * a CSS grid with a fixed-width left column (`--split-left-width`,
 * 340 px by default) and a flex-right column. Below `md:`, only the
 * left slot is painted — the page's legacy single-column routes handle
 * the detail URL by replacing the left content entirely via React
 * Router navigation.
 *
 * Both slots are landmark regions (`<section aria-label="…">`) so
 * assistive tech can announce the split layout, and each is its own
 * `overflow-y-auto` scroll container so scrolling the list doesn't
 * drag the detail pane along.
 *
 * Props:
 *  - `left`, `right` — ReactNode slots. Typically the list and the
 *    `<Outlet />` (or an empty-state placeholder).
 *  - `leftLabel`, `rightLabel` — German aria-labels for the landmark
 *    regions, e.g. "Rezept-Liste" / "Rezept-Detail".
 *  - `className` — forwarded onto the outer wrapper so pages can add
 *    vertical padding or custom height scaffolding.
 */
export interface SplitPaneProps {
  left: ReactNode
  right: ReactNode
  leftLabel: string
  rightLabel: string
  className?: string
}

export function SplitPane({
  left,
  right,
  leftLabel,
  rightLabel,
  className,
}: SplitPaneProps) {
  return (
    <div
      className={cn(
        // Mobile: single column via default flow. `block` is the default
        // for divs, we just spell it here for symmetry with `md:grid`.
        'block',
        // md+: CSS grid with the token-driven left column + flexible
        // right column. Both slots share the full available height.
        'md:grid md:h-full md:min-h-0 md:grid-cols-[var(--split-left-width)_1fr]',
        className,
      )}
    >
      <section
        aria-label={leftLabel}
        className="min-h-0 overflow-y-auto md:border-r md:border-border"
      >
        {left}
      </section>
      <section
        aria-label={rightLabel}
        // `hidden md:block` keeps the right slot OUT of the mobile
        // single-column flow; the page handles detail navigation via
        // the legacy `/groups/:id/recipes/:recipeId` route instead.
        className="hidden min-h-0 overflow-y-auto md:block"
      >
        {right}
      </section>
    </div>
  )
}
