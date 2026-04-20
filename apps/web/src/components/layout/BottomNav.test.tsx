import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { GroupSummary } from '@familien-kochbuch/shared'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { BottomNav } from './BottomNav'

function renderAt(initialPath: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/*" element={<LocationProbe>{children}</LocationProbe>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    )
  }
  return render(<BottomNav />, { wrapper: Wrapper })
}

/**
 * Surfaces the active pathname into the DOM so navigation assertions
 * can wait on the URL changing without setting up a fake routes table.
 */
function LocationProbe({ children }: { children: ReactNode }) {
  const location = useLocation()
  return (
    <>
      <div data-testid="current-path">{location.pathname}</div>
      {children}
    </>
  )
}

function groupSummary(over: Partial<GroupSummary>): GroupSummary {
  return {
    id: 'g1',
    name: 'Example Family',
    description: null,
    coverImageUrl: null,
    defaultServings: 3,
    isPrivateCollection: false,
    memberCount: 4,
    myRole: 'Admin',
    ...over,
  }
}

/**
 * DS3 bottom navigation.
 *
 * Spec: `docs/mockups/warme-kueche-home.html` — 5 items (Start,
 * Gruppen, + FAB, Wochenplan, Profil) fixed to the bottom with a
 * cream/blur backdrop.
 */
describe('<BottomNav />', () => {
  afterEach(() => {
    server.resetHandlers()
    useAuthStore.getState().clear()
  })

  it('renders all five navigation items in the expected order', () => {
    renderAt('/')
    const nav = screen.getByRole('navigation', { name: /hauptnavigation/i })
    // Now the FAB is a `<button>` and the four nav items are `<a>`s.
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

  // ───────── BUG-008 regression ─────────

  it('renders the + FAB as a button that opens the create sheet (not a navigation link)', () => {
    renderAt('/')
    const plus = screen.getByRole('button', { name: /neues rezept/i })
    expect(plus).toHaveAttribute('aria-haspopup', 'dialog')
    expect(plus).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens the CreateActionSheet with all 5 actions when the FAB is tapped (1+ groups)', async () => {
    server.use(
      http.get('/api/groups', () =>
        HttpResponse.json<GroupSummary[]>([
          groupSummary({ id: 'g1', name: 'Familie' }),
          groupSummary({ id: 'g2', name: 'Freunde' }),
        ]),
      ),
    )
    renderAt('/')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /neues rezept/i }))

    const dialog = await screen.findByRole('dialog', { name: /was möchtest du anlegen/i })
    expect(dialog).toBeInTheDocument()
    // Wait for the groups query to resolve so all conditional actions render.
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /rezept manuell anlegen/i }),
      ).toBeInTheDocument(),
    )
    expect(screen.getByRole('button', { name: /aus video \/ url importieren/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /aus fotos importieren/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /im chat erfinden/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /neue gruppe anlegen/i })).toBeInTheDocument()
  })

  it('only offers "Neue Gruppe anlegen" when the user is in 0 groups', async () => {
    server.use(http.get('/api/groups', () => HttpResponse.json<GroupSummary[]>([])))
    renderAt('/')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /neues rezept/i }))

    await screen.findByRole('dialog', { name: /was möchtest du anlegen/i })
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /neue gruppe anlegen/i }),
      ).toBeInTheDocument(),
    )
    expect(screen.queryByRole('button', { name: /aus video \/ url/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /aus fotos importieren/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /im chat erfinden/i })).not.toBeInTheDocument()
  })

  it('navigates to /groups/{id}/recipes/new when the user is in exactly one group', async () => {
    server.use(
      http.get('/api/groups', () =>
        HttpResponse.json<GroupSummary[]>([groupSummary({ id: 'only-group' })]),
      ),
    )
    renderAt('/')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /neues rezept/i }))
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /rezept manuell anlegen/i }),
      ).toBeInTheDocument(),
    )
    await user.click(screen.getByRole('button', { name: /rezept manuell anlegen/i }))

    await waitFor(() =>
      expect(screen.getByTestId('current-path')).toHaveTextContent(
        '/groups/only-group/recipes/new',
      ),
    )
  })

  it('navigates to /rezepte/import/url when "URL importieren" is picked', async () => {
    server.use(
      http.get('/api/groups', () =>
        HttpResponse.json<GroupSummary[]>([groupSummary({ id: 'g1' })]),
      ),
    )
    renderAt('/')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /neues rezept/i }))
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /aus video \/ url importieren/i }),
      ).toBeInTheDocument(),
    )
    await user.click(screen.getByRole('button', { name: /aus video \/ url importieren/i }))

    await waitFor(() =>
      expect(screen.getByTestId('current-path')).toHaveTextContent('/rezepte/import/url'),
    )
  })

  it('closes the sheet on Escape', async () => {
    server.use(
      http.get('/api/groups', () =>
        HttpResponse.json<GroupSummary[]>([groupSummary({ id: 'g1' })]),
      ),
    )
    renderAt('/')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /neues rezept/i }))
    expect(
      await screen.findByRole('dialog', { name: /was möchtest du anlegen/i }),
    ).toBeInTheDocument()

    await user.keyboard('{Escape}')

    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: /was möchtest du anlegen/i }),
      ).not.toBeInTheDocument(),
    )
  })

  // ───────── BUG-014 regression ─────────

  it('anchors the nav with a safe-area-inset-aware bottom + padding (BUG-014)', () => {
    renderAt('/')
    const nav = screen.getByRole('navigation', { name: /hauptnavigation/i })
    // The exact Tailwind arbitrary-value class is the contract for the
    // safe-area handling — assert both the position anchor and the row
    // padding so a future refactor can't silently regress one of them.
    // BUG-023 wraps the `bottom` anchor in a `calc(... + var(--viewport-
    // bottom-offset, 0px))` chain; both forms keep the safe-area inset
    // present, which is what BUG-014 actually guards against.
    expect(nav.className).toMatch(/bottom-\[(?:env\(safe-area-inset-bottom,0px\)|calc\(env\(safe-area-inset-bottom,0px\)\+[^\]]+)\]/)
    expect(nav.className).toMatch(/pb-\[env\(safe-area-inset-bottom,0px\)\]/)
  })

  // ───────── BUG-021 regression ─────────

  it('exposes a --bottom-nav-height custom property in index.css so overlays can clear the nav', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const css = readFileSync(resolve(here, '../../index.css'), 'utf8')
    // RecipeActionBar's bottom-offset depends on this token. Guard against
    // accidental removal that would silently re-introduce BUG-021.
    expect(css).toMatch(/--bottom-nav-height\s*:/)
  })

  // ───────── BUG-023 regression ─────────

  it('chains var(--viewport-bottom-offset) into the bottom anchor (BUG-023)', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(resolve(here, './BottomNav.tsx'), 'utf8')
    // Without the offset the nav lags the visual viewport when iOS/Chrome
    // retracts the toolbar mid-scroll, leaving a transparent gap below the
    // backdrop-blur'd row. Same grep-gate pattern as the BUG-021 token
    // guard above.
    expect(source).toMatch(/var\(--viewport-bottom-offset/)
  })
})
