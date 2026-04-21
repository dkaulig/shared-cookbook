import { useState } from 'react'
import { Plus } from 'lucide-react'
import { NavLink } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { CreateActionSheet } from './CreateActionSheet'
import { CreateGroupDialog } from '@/features/groups/CreateGroupDialog'
import { useBottomZoneConsumer } from './bottomZone'
import { navItems, type NavItem } from './navItems'

/**
 * DS3 bottom navigation (mobile first).
 *
 * Mirrors `.bottomnav` in `docs/mockups/warme-kueche-home.html`:
 *   Start · Gruppen · + FAB · Wochenplan · Profil
 *
 * BUG-039 — hoppr-style flex-column layout. The nav is no longer a
 * `fixed`-positioned overlay; it's a plain `flex-shrink-0` sibling of
 * `<main>` inside `AppLayout`'s `fixed inset-0 flex flex-col` root.
 * Because the root document never scrolls, the browser URL bar never
 * animates → no gap to compensate for, no `visualViewport` listener,
 * no `--viewport-bottom-offset` chain. Safe-area inset is handled
 * with the `.pb-safe` utility (defined in `index.css`).
 *
 * The Bottom-Zone slot pattern (BUG-036) stays intact: a contextual
 * row (pushed in via `useBottomZoneSlot`) sits ABOVE the 5-item nav
 * row, separated by a subtle border. Both rows share the same outer
 * flex wrapper.
 */
export function BottomNav() {
  const [createSheetOpen, setCreateSheetOpen] = useState(false)
  const [createGroupOpen, setCreateGroupOpen] = useState(false)
  const { slot, containerRef } = useBottomZoneConsumer()

  return (
    <>
      <div
        ref={containerRef}
        data-testid="bottom-zone-container"
        className={cn(
          // BUG-039 — flex-shrink-0 + pb-safe. No `fixed`, no `bottom:`,
          // no z-index: the parent `<AppLayout>` is a flex-column on a
          // fixed-viewport root, so this sibling naturally docks to
          // the bottom edge and spans the full width.
          'flex-shrink-0 pb-safe',
          'bg-[hsl(var(--background)/0.92)] backdrop-blur supports-[backdrop-filter]:bg-[hsl(var(--background)/0.82)]',
          'border-t border-border',
          'md:hidden',
        )}
      >
        {slot != null && (
          <div
            data-testid="bottom-zone-slot"
            className="flex items-stretch gap-2.5 px-3 py-2.5 border-b border-border/60"
          >
            {slot}
          </div>
        )}
        <nav
          aria-label="Hauptnavigation"
          className="flex items-stretch justify-around"
        >
          {navItems.slice(0, 2).map((item) => (
            <NavItemLink key={item.to} item={item} />
          ))}

          {/* Centre "+ neues Rezept" FAB — elevates above the row and owns
              its own shadow so it reads as the primary action. BUG-008:
              now opens the create-action sheet instead of navigating away. */}
          <button
            type="button"
            aria-label="Neues Rezept"
            aria-haspopup="dialog"
            aria-expanded={createSheetOpen}
            onClick={() => setCreateSheetOpen(true)}
            className="relative flex flex-1 flex-col items-center gap-1 pb-3 pt-2 text-[11px] font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <span
              aria-hidden="true"
              className="-mt-[14px] grid h-[52px] w-[52px] place-items-center rounded-full bg-primary text-primary-foreground shadow-[0_6px_20px_-4px_rgba(180,83,9,0.55),0_2px_6px_rgba(0,0,0,0.1)] transition-colors hover:bg-[hsl(var(--primary-hover))]"
            >
              <Plus className="h-6 w-6" strokeWidth={2.4} aria-hidden="true" />
            </span>
            <span>Neu</span>
          </button>

          {navItems.slice(2).map((item) => (
            <NavItemLink key={item.to} item={item} />
          ))}
        </nav>
      </div>

      {createSheetOpen && (
        <CreateActionSheet
          onClose={() => setCreateSheetOpen(false)}
          onCreateGroup={() => setCreateGroupOpen(true)}
        />
      )}
      {createGroupOpen && (
        <CreateGroupDialog onClose={() => setCreateGroupOpen(false)} />
      )}
    </>
  )
}

function NavItemLink({ item }: { item: NavItem }) {
  const Icon = item.icon
  return (
    <NavLink
      to={item.to}
      // Gruppen should stay active on `/groups/:id` — pass `end` only
      // for the root Start link so it doesn't match every sub-route.
      end={item.to === '/'}
      aria-label={item.label}
      className={({ isActive }) =>
        cn(
          'flex min-h-[56px] flex-1 flex-col items-center gap-[3px] px-1 pb-3 pt-2 text-[11px]',
          'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          isActive ? 'text-primary' : 'text-muted-foreground hover:text-primary',
        )
      }
    >
      <Icon className="h-[22px] w-[22px]" aria-hidden="true" />
      <span>{item.label}</span>
    </NavLink>
  )
}
