import { NavLink } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { navItems, type NavItem } from './navItems'

/**
 * TABLET-5 — horizontal primary-nav for the desktop zone (`≥ xl`,
 * 1280 px+).
 *
 * Closes the UX cliff introduced by TABLET-0: below `xl` the BottomNav
 * (mobile) / SideRail (tablet) provide primary navigation, but at
 * `≥ xl` both are hidden — without this bar the user would have no
 * nav affordance at all on a wide-screen browser. DesktopTopNav sits
 * as a flex-shrink-0 row between the shared brand <TopNav /> and the
 * main band so `<main>` scrolls beneath both strips.
 *
 * Consumes the shared `navItems` module so BottomNav + SideRail +
 * DesktopTopNav can never drift on route / label / icon.
 *
 * Visibility: `hidden xl:flex` — the component renders in every zone
 * (markup is static, no window.innerWidth race) but collapses to
 * display:none below 1280 px, freeing the BottomNav / SideRail to own
 * those viewports.
 *
 * Accessibility:
 * - `<nav aria-label="Desktop-Navigation">` so assistive tech
 *   can distinguish it from the BottomNav's "Hauptnavigation" and the
 *   SideRail's "Seitenleiste" landmarks — all three coexist in the DOM.
 * - Each NavLink carries `focus-visible:ring-*` so keyboard users
 *   see the active target; `<a>`s are natively tab-focusable.
 * - `NavLink` sets `aria-current="page"` on the active match, powering
 *   the coloured highlight via the same `text-primary` token SideRail
 *   and BottomNav use.
 */
export function DesktopTopNav() {
  return (
    <nav
      aria-label="Desktop-Navigation"
      className={cn(
        // Only visible at ≥ xl (1280 px+); hidden below so BottomNav /
        // SideRail own those viewports with zero layout math — the
        // display:none removes the bar from the flex track entirely.
        'hidden xl:flex',
        'h-[var(--desktop-topnav-height)] shrink-0 items-center gap-1 border-b border-border bg-background px-4',
      )}
    >
      {navItems.map((item) => (
        <DesktopTopNavLink key={item.to} item={item} />
      ))}
    </nav>
  )
}

function DesktopTopNavLink({ item }: { item: NavItem }) {
  const Icon = item.icon
  return (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      aria-label={item.label}
      className={({ isActive }) =>
        cn(
          'inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium',
          'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          isActive ? 'text-primary' : 'text-muted-foreground',
          // Hover-affordance only for pointer devices — consistent with
          // SideRail's TABLET-0 hover policy so touch-capable desktop
          // hybrids don't get sticky hover states after a tap.
          '[@media(hover:hover)]:hover:text-primary',
        )
      }
    >
      <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
      <span className="leading-none">{item.label}</span>
    </NavLink>
  )
}
