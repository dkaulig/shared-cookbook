import { Calendar, Home, User, Users } from 'lucide-react'
import type { ComponentType, SVGProps } from 'react'

/**
 * TABLET-0 — shared nav-item source of truth.
 *
 * Both <BottomNav /> (mobile, `< md`) and <SideRail /> (tablet,
 * `md:`–`xl:`) render the same four routes in the same order with
 * the same icons + labels. Centralising the list here guarantees
 * the two nav surfaces never drift — changing a route, label, or
 * icon updates both at once.
 *
 * The `+ Neues Rezept` FAB between Gruppen and Wochenplan is NOT
 * a route and therefore not in this list; BottomNav renders it
 * inline between the 2nd and 3rd NavLink. Keeping the route list
 * pure avoids each consumer having to filter around a special
 * pseudo-item.
 */
export type NavItem = {
  to: string
  label: string
  icon: ComponentType<SVGProps<SVGSVGElement>>
}

export const navItems: readonly NavItem[] = [
  { to: '/', label: 'Start', icon: Home },
  { to: '/groups', label: 'Gruppen', icon: Users },
  { to: '/wochenplan', label: 'Wochenplan', icon: Calendar },
  { to: '/profil', label: 'Profil', icon: User },
] as const
