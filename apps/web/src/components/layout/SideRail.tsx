import { NavLink } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { navItems, type NavItem } from './navItems'

/**
 * TABLET-0 — vertical nav-rail for the tablet zone (`md:`–`xl:`,
 * 768–1279 px).
 *
 * Mirrors the route list + icons from <BottomNav /> via the shared
 * `navItems` module so the two surfaces can never drift. The rail
 * itself is visibility-gated by the parent layout (`hidden md:flex
 * xl:hidden`); rendering in all three viewport zones and relying on
 * display:none from Tailwind keeps the markup static and avoids a
 * window-width race during SSR/hydration.
 *
 * Layout: 72 px wide (`w-[var(--side-rail-width)]`), full-height
 * flex-column sibling of `<main>` inside the hoppr-style
 * `fixed inset-0 flex flex-col overflow-hidden` shell. The rail sits
 * LEFT of `<main>` — `<AppLayout>` wires a horizontal flex wrapper
 * around the main + rail pair so they share the vertical axis
 * between TopNav and BottomNav.
 *
 * Accessibility:
 * - `<nav aria-label="Seitenleiste">` so assistive tech can distinguish
 *   it from the BottomNav's "Hauptnavigation" landmark (both will be
 *   present in the DOM at the same time, only visibility differs).
 * - Each NavLink carries `focus-visible:ring-*` so keyboard users see
 *   the active target; `<a>`s are natively tab-focusable.
 * - `NavLink` sets `aria-current="page"` on the active match, powering
 *   the coloured highlight via the same `text-primary` token BottomNav
 *   uses.
 */
export function SideRail() {
  const { t } = useTranslation()
  return (
    <nav
      aria-label={t('a11y.sideRail', { defaultValue: 'Seitenleiste' })}
      className={cn(
        // Only visible in the tablet zone — hidden below md (BottomNav
        // takes over) and at/above xl (future Desktop TopNav scope).
        'hidden md:flex xl:hidden',
        'w-[var(--side-rail-width)] shrink-0 flex-col items-stretch gap-1 border-r border-border bg-background py-3',
      )}
    >
      {navItems.map((item) => (
        <SideRailLink key={item.to} item={item} />
      ))}
    </nav>
  )
}

function SideRailLink({ item }: { item: NavItem }) {
  const Icon = item.icon
  const { t } = useTranslation()
  const label = t(item.labelKey, { defaultValue: item.label })
  return (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      aria-label={label}
      className={({ isActive }) =>
        cn(
          'flex flex-col items-center gap-1 px-1 py-2 text-[11px] font-medium',
          'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          isActive ? 'text-primary' : 'text-muted-foreground',
          // Hover-affordance only for pointer devices — on touch-only
          // tablets without a Bluetooth mouse, a persistent hover-state
          // would stick after a tap (TABLET-0 hover policy).
          '[@media(hover:hover)]:hover:text-primary',
        )
      }
    >
      <Icon className="h-[22px] w-[22px]" aria-hidden="true" />
      <span className="leading-none">{label}</span>
    </NavLink>
  )
}
