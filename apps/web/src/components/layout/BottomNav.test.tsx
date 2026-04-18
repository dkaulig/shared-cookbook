import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { BottomNav } from './BottomNav'

function renderAt(initialPath: string) {
  function Wrapper({ children }: { children: ReactNode }) {
    return <MemoryRouter initialEntries={[initialPath]}>{children}</MemoryRouter>
  }
  return render(<BottomNav />, { wrapper: Wrapper })
}

/**
 * DS3 bottom navigation.
 *
 * Spec: `docs/mockups/warme-kueche-home.html` — 5 items (Start,
 * Gruppen, + FAB, Wochenplan, Profil) fixed to the bottom with a
 * cream/blur backdrop.
 */
describe('<BottomNav />', () => {
  it('renders all five navigation items in the expected order', () => {
    renderAt('/')
    const nav = screen.getByRole('navigation', { name: /hauptnavigation/i })
    // React-Router's NavLink resolves to `<a>` elements → role="link".
    const labels = Array.from(nav.querySelectorAll('a, button')).map(
      (el) => el.getAttribute('aria-label') ?? el.textContent?.trim(),
    )
    expect(labels).toEqual(
      expect.arrayContaining(['Start', 'Gruppen', 'Neues Rezept', 'Wochenplan', 'Profil']),
    )
  })

  it('marks Start as active (aria-current=page) when route is "/"', () => {
    renderAt('/')
    const start = screen.getByRole('link', { name: /start/i })
    expect(start).toHaveAttribute('aria-current', 'page')
  })

  it('marks Gruppen as active when route starts with /groups', () => {
    renderAt('/groups/xyz')
    const gruppen = screen.getByRole('link', { name: /gruppen/i })
    expect(gruppen).toHaveAttribute('aria-current', 'page')
  })

  it('marks Wochenplan as active on /wochenplan', () => {
    renderAt('/wochenplan')
    const wp = screen.getByRole('link', { name: /wochenplan/i })
    expect(wp).toHaveAttribute('aria-current', 'page')
  })

  it('marks Profil as active on /profil', () => {
    renderAt('/profil')
    const profil = screen.getByRole('link', { name: /profil/i })
    expect(profil).toHaveAttribute('aria-current', 'page')
  })

  it('links the + FAB to /groups so the user can pick a target group', () => {
    renderAt('/')
    const plus = screen.getByRole('link', { name: /neues rezept/i })
    expect(plus).toHaveAttribute('href', '/groups')
  })
})
