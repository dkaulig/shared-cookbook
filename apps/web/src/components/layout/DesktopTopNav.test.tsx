import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { DesktopTopNav } from './DesktopTopNav'
import { navItems } from './navItems'

/**
 * TABLET-5 — desktop horizontal primary-nav spec.
 *
 * Rendered only at `≥ xl` (1280 px+). Horizontal icon+label row that
 * sits below the shared brand TopNav. Consumes the shared `navItems`
 * source so BottomNav + SideRail + DesktopTopNav stay in sync. All
 * copy is German.
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
  return render(<DesktopTopNav />, { wrapper: Wrapper })
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

describe('<DesktopTopNav />', () => {
  it('renders every shared navItem as a link in the expected order', () => {
    renderAt('/')
    const nav = screen.getByRole('navigation', { name: /desktop-navigation/i })
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

  it('marks Profil as active on /profil', () => {
    renderAt('/profil')
    expect(screen.getByRole('link', { name: /profil/i })).toHaveAttribute('aria-current', 'page')
  })

  it('is scoped to the desktop zone via `hidden xl:flex`', () => {
    renderAt('/')
    const nav = screen.getByRole('navigation', { name: /desktop-navigation/i })
    // `hidden` at < xl, `xl:flex` at 1280+. Mobile (400 px) + Tablet
    // (900 px) viewports therefore render it as display:none — the
    // BottomNav / SideRail own those zones.
    expect(nav.className).toMatch(/\bhidden\b/)
    expect(nav.className).toMatch(/\bxl:flex\b/)
  })

  it('carries the --desktop-topnav-height token, border-b, and bg-background (brand-consistent chrome)', () => {
    renderAt('/')
    const nav = screen.getByRole('navigation', { name: /desktop-navigation/i })
    expect(nav.className).toMatch(/\bh-\[var\(--desktop-topnav-height\)\]/)
    expect(nav.className).toMatch(/\bborder-b\b/)
    expect(nav.className).toMatch(/\bbg-background\b/)
  })

  it('each nav link is keyboard-focusable and carries a visible focus-ring utility', () => {
    renderAt('/')
    const links = screen
      .getByRole('navigation', { name: /desktop-navigation/i })
      .querySelectorAll('a')
    expect(links.length).toBeGreaterThan(0)
    for (const link of Array.from(links)) {
      expect(link.className).toMatch(/focus-visible:ring/)
    }
  })

  it('can tab-navigate through every nav link in DOM order', async () => {
    renderAt('/')
    const user = userEvent.setup()
    const links = Array.from(
      screen.getByRole('navigation', { name: /desktop-navigation/i }).querySelectorAll('a'),
    )
    await user.tab()
    expect(document.activeElement).toBe(links[0])
    for (let i = 1; i < links.length; i++) {
      await user.tab()
      expect(document.activeElement).toBe(links[i])
    }
  })

  // Reuse the TABLET-0 shared-source guard for the new consumer.
  it('DesktopTopNav.tsx imports the shared navItems module (no hand-rolled copy)', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(resolve(here, './DesktopTopNav.tsx'), 'utf8')
    expect(source).toMatch(/from ['"]\.\/navItems['"]/)
  })
})
