import { useState } from 'react'
import { Calendar, Home, Plus, User, Users } from 'lucide-react'
import { NavLink } from 'react-router-dom'
import type { ComponentType, SVGProps } from 'react'
import { cn } from '@/lib/utils'
import { CreateActionSheet } from './CreateActionSheet'
import { CreateGroupDialog } from '@/features/groups/CreateGroupDialog'

/**
 * DS3 bottom navigation (mobile first).
 *
 * Mirrors `.bottomnav` in `docs/mockups/warme-kueche-home.html`:
 *   Start · Gruppen · + FAB · Wochenplan · Profil
 *
 * - Sticky bottom + `backdrop-blur` + safe-area inset so the nav floats
 *   above a scrolling page and clears the iOS home indicator.
 * - Four symmetric items plus a centred FAB; the FAB now opens a
 *   `<CreateActionSheet>` (BUG-008) instead of jumping straight to
 *   `/groups`. The sheet branches into manual recipe / URL import / photo
 *   import / chat / new group.
 *
 * BUG-014 — the nav previously sat with a flat `bottom-0` and a single
 * inline `paddingBottom: env(safe-area-inset-bottom)`. On iOS Safari the
 * URL-bar retraction animation could briefly overlap the row because the
 * `bottom` anchor itself ignored the safe-area inset. We now combine
 * `bottom-[env(safe-area-inset-bottom,0px)]` (push the whole nav up out
 * of the chrome zone) with the existing `pb-…` (give the row breathing
 * room above the home indicator) so both Android Chrome and iOS Safari
 * keep the row visually clear of dynamic browser chrome.
 */
type NavItem = {
  to: string
  label: string
  icon: ComponentType<SVGProps<SVGSVGElement>>
}

const items: NavItem[] = [
  { to: '/', label: 'Start', icon: Home },
  { to: '/groups', label: 'Gruppen', icon: Users },
  { to: '/wochenplan', label: 'Wochenplan', icon: Calendar },
  { to: '/profil', label: 'Profil', icon: User },
]

export function BottomNav() {
  const [createSheetOpen, setCreateSheetOpen] = useState(false)
  const [createGroupOpen, setCreateGroupOpen] = useState(false)

  return (
    <>
      <nav
        aria-label="Hauptnavigation"
        className={cn(
          // BUG-014: anchor `bottom` to the safe-area inset so the nav
          // is pushed above iOS/Android dynamic browser chrome instead
          // of sitting flush against `bottom: 0`.
          // BUG-023: also add `--viewport-bottom-offset` so the nav
          // follows the visual viewport when iOS/Chrome retracts the
          // toolbar mid-scroll (closing the gap a backdrop-blur'd row
          // would otherwise reveal).
          'fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom,0px)+var(--viewport-bottom-offset,0px))] z-30 flex items-stretch justify-around border-t border-border',
          // Keep the previous home-indicator padding so the row itself
          // also has breathing room from the very bottom edge on iOS.
          'pb-[env(safe-area-inset-bottom,0px)]',
          'bg-[hsl(var(--background)/0.92)] backdrop-blur supports-[backdrop-filter]:bg-[hsl(var(--background)/0.82)]',
          'md:hidden',
        )}
      >
        {items.slice(0, 2).map((item) => (
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

        {items.slice(2).map((item) => (
          <NavItemLink key={item.to} item={item} />
        ))}
      </nav>

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
