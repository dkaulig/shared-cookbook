import { Calendar, Home, Search, User, Users } from 'lucide-react'
import type { ComponentType, SVGProps } from 'react'

/**
 * TABLET-0 — shared nav-item source of truth.
 *
 * Both <BottomNav /> (mobile, `< md`), <SideRail /> (tablet,
 * `md:`–`xl:`), and <DesktopTopNav /> (≥ xl) render the same routes
 * in the same order with the same icons + labels. Centralising the
 * list here guarantees the three nav surfaces never drift — changing
 * a route, label, or icon updates all at once.
 *
 * SEARCH-1 — /suche is inserted between /groups and /wochenplan so the
 * global-search affordance sits next to the group list on every nav
 * surface. BottomNav grows from 4 + FAB slots to 5 + FAB (6 total);
 * at 390 px this yields ~65 px per slot, still comfortably above the
 * 44 px touch-target floor.
 *
 * The `+ Neues Rezept` FAB between Gruppen and Suche is NOT a route
 * and therefore not in this list; BottomNav renders it inline via
 * `navItems.slice(0, 2)` + FAB + `navItems.slice(2)`. Keeping the
 * route list pure avoids each consumer having to filter around a
 * special pseudo-item.
 */
export type NavItem = {
  to: string
  label: string
  icon: ComponentType<SVGProps<SVGSVGElement>>
}

export const navItems: readonly NavItem[] = [
  { to: '/', label: 'Start', icon: Home },
  { to: '/groups', label: 'Gruppen', icon: Users },
  { to: '/suche', label: 'Suche', icon: Search },
  { to: '/wochenplan', label: 'Wochenplan', icon: Calendar },
  { to: '/profil', label: 'Profil', icon: User },
] as const
