import { Calendar, Home, Search, Users } from 'lucide-react'
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
 * surface.
 *
 * Profil (2026-04-21): dropped from this list. The avatar in the
 * sticky <TopNav /> banner (visible on every viewport) already links
 * to /profil — keeping a second entry in the bottom / side / top nav
 * is redundant clutter.
 *
 * REL-3 (i18n): `labelKey` is the i18next key the nav surfaces resolve
 * via `t()`. The literal `label` property stays alongside as the
 * German fallback + as a stable value for drift-guard tests that run
 * without a React context.
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
  labelKey: string
  icon: ComponentType<SVGProps<SVGSVGElement>>
}

export const navItems: readonly NavItem[] = [
  { to: '/', label: 'Start', labelKey: 'nav.home', icon: Home },
  { to: '/groups', label: 'Gruppen', labelKey: 'nav.groups', icon: Users },
  { to: '/suche', label: 'Suche', labelKey: 'nav.search', icon: Search },
  {
    to: '/wochenplan',
    label: 'Wochenplan',
    labelKey: 'nav.mealplan',
    icon: Calendar,
  },
] as const
