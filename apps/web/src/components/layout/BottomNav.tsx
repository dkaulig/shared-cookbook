import { Calendar, Home, Plus, User, Users } from 'lucide-react'
import { NavLink } from 'react-router-dom'
import type { ComponentType, SVGProps } from 'react'
import { cn } from '@/lib/utils'

/**
 * DS3 bottom navigation (mobile first).
 *
 * Mirrors `.bottomnav` in `docs/mockups/warme-kueche-home.html`:
 *   Start · Gruppen · + FAB · Wochenplan · Profil
 *
 * - Sticky bottom + `backdrop-blur` + safe-area inset so the nav floats
 *   above a scrolling page and clears the iOS home indicator.
 * - Four symmetric items plus a centred FAB that sits 14 px above the
 *   row and opens the "new recipe" flow via `/groups` (the user picks
 *   a target group there — the Home page has no group context yet).
 *
 * Wochenplan + Profil remain stubs wired by DS3; DS7 will flesh them
 * out once the protected-route shell has settled.
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
  return (
    <nav
      aria-label="Hauptnavigation"
      className={cn(
        'fixed inset-x-0 bottom-0 z-30 flex items-stretch justify-around border-t border-border',
        'bg-[hsl(var(--background)/0.92)] backdrop-blur supports-[backdrop-filter]:bg-[hsl(var(--background)/0.82)]',
        'md:hidden',
      )}
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      {items.slice(0, 2).map((item) => (
        <NavItemLink key={item.to} item={item} />
      ))}

      {/* Centre "+ neues Rezept" FAB — elevates above the row and owns
          its own shadow so it reads as the primary action. */}
      <NavLink
        to="/groups"
        aria-label="Neues Rezept"
        className="relative flex flex-1 flex-col items-center gap-1 pb-3 pt-2 text-[11px] font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <span
          aria-hidden="true"
          className="-mt-[14px] grid h-[52px] w-[52px] place-items-center rounded-full bg-primary text-primary-foreground shadow-[0_6px_20px_-4px_rgba(180,83,9,0.55),0_2px_6px_rgba(0,0,0,0.1)] transition-colors hover:bg-[hsl(var(--primary-hover))]"
        >
          <Plus className="h-6 w-6" strokeWidth={2.4} aria-hidden="true" />
        </span>
        <span>Neu</span>
      </NavLink>

      {items.slice(2).map((item) => (
        <NavItemLink key={item.to} item={item} />
      ))}
    </nav>
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
