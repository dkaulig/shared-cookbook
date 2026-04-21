import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { SideRail } from './SideRail'
import { navItems } from './navItems'

/**
 * TABLET-0 — side-rail spec.
 *
 * Rendered only at `md:`–`xl:` (768–1279 px). Vertical icon+label
 * stack, 72 px wide, sticky left, `bg-background border-r`. Consumes
 * the shared `navItems` source so BottomNav + SideRail stay in sync.
 * All copy is German (project convention).
 */
function renderAt(initialPath: string) {
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/*" element={<LocationProbe>{children}</LocationProbe>} />
        </Routes>
      </MemoryRouter>
    )
  }
  return render(<SideRail />, { wrapper: Wrapper })
}

function LocationProbe({ children }: { children: ReactNode }) {
  const location = useLocation()
  return (
    <>
      <div data-testid="current-path">{location.pathname}</div>
      {children}
    </>
  )
}

describe('<SideRail />', () => {
  it('renders every shared navItem as a link in the expected order', () => {
    renderAt('/')
    const nav = screen.getByRole('navigation', { name: /seitenleiste/i })
    const links = Array.from(nav.querySelectorAll('a'))
    const labels = links.map((el) => el.getAttribute('aria-label') ?? el.textContent?.trim())
    expect(labels).toEqual(navItems.map((item) => item.label))
  })

  it('marks Start as active (aria-current=page) when route is "/"', () => {
    renderAt('/')
    expect(screen.getByRole('link', { name: /start/i })).toHaveAttribute('aria-current', 'page')
  })

  it('marks Gruppen as active when route starts with /groups', () => {
    renderAt('/groups/xyz')
    expect(screen.getByRole('link', { name: /gruppen/i })).toHaveAttribute('aria-current', 'page')
  })

  it('marks Wochenplan as active on /wochenplan', () => {
    renderAt('/wochenplan')
    expect(screen.getByRole('link', { name: /wochenplan/i })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('does not render a Profil item (avatar in TopNav owns /profil)', () => {
    renderAt('/profil')
    const rail = screen.getByRole('navigation', { name: /seitenleiste/i })
    const labels = Array.from(rail.querySelectorAll('a')).map((a) => a.textContent?.trim())
    expect(labels).not.toContain('Profil')
  })

  // SEARCH-1 — global search is now a first-class nav entry, surfaced
  // on every nav affordance (BottomNav, SideRail, DesktopTopNav).
  it('marks Suche as active on /suche (SEARCH-1)', () => {
    renderAt('/suche')
    expect(screen.getByRole('link', { name: /suche/i })).toHaveAttribute('aria-current', 'page')
  })

  it('carries the 72 px side-rail width token + border-r + bg-background + vertical flex', () => {
    renderAt('/')
    const nav = screen.getByRole('navigation', { name: /seitenleiste/i })
    // Rail must reserve its fixed tablet-zone width via the CSS token.
    expect(nav.className).toMatch(/\bw-\[var\(--side-rail-width\)\]/)
    expect(nav.className).toMatch(/\bborder-r\b/)
    expect(nav.className).toMatch(/\bbg-background\b/)
    expect(nav.className).toMatch(/\bflex-col\b/)
  })

  it('each nav link is keyboard-focusable and carries a visible focus-ring utility', () => {
    renderAt('/')
    const links = screen
      .getByRole('navigation', { name: /seitenleiste/i })
      .querySelectorAll('a')
    expect(links.length).toBeGreaterThan(0)
    for (const link of Array.from(links)) {
      // NavLink renders a real <a> — which is focusable by default.
      // Guard the focus-ring utility so TAB navigation is visible.
      expect(link.className).toMatch(/focus-visible:ring/)
    }
  })

  it('can tab-navigate through every nav link in DOM order', async () => {
    renderAt('/')
    const user = userEvent.setup()
    const links = Array.from(
      screen.getByRole('navigation', { name: /seitenleiste/i }).querySelectorAll('a'),
    )
    await user.tab()
    expect(document.activeElement).toBe(links[0])
    for (let i = 1; i < links.length; i++) {
      await user.tab()
      expect(document.activeElement).toBe(links[i])
    }
  })
})
