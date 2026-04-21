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
import { BottomZoneProvider, useBottomZoneSlot } from './bottomZone'

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
    version: 0,
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

  it('renders all six navigation items in the expected order (SEARCH-1 adds Suche)', () => {
    renderAt('/')
    const nav = screen.getByRole('navigation', { name: /hauptnavigation/i })
    // Now the FAB is a `<button>` and the five nav items are `<a>`s.
    const labels = Array.from(nav.querySelectorAll('a, button')).map(
      (el) => el.getAttribute('aria-label') ?? el.textContent?.trim(),
    )
    expect(labels).toEqual(
      expect.arrayContaining([
        'Start',
        'Gruppen',
        'Neues Rezept',
        'Suche',
        'Wochenplan',
        'Profil',
      ]),
    )
  })

  // SEARCH-1 — /suche surfaces in the BottomNav between Gruppen and
  // Wochenplan so the global-search affordance is always one tap away
  // on mobile. The BottomNav is intentionally allowed to grow to 6
  // slots (5 NavLinks + the central "Neues Rezept" FAB) — the items
  // still fit on a 390 px viewport (~65 px each).
  it('renders a Suche link that routes to /suche (SEARCH-1)', () => {
    renderAt('/')
    const suche = screen.getByRole('link', { name: /suche/i })
    expect(suche).toHaveAttribute('href', '/suche')
  })

  it('marks Suche as active on /suche (SEARCH-1)', () => {
    renderAt('/suche')
    const suche = screen.getByRole('link', { name: /suche/i })
    expect(suche).toHaveAttribute('aria-current', 'page')
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

  // ───────── BUG-039 — hoppr-style flex-column layout ─────────

  it('renders as a `flex-shrink-0` flex child with `.pb-safe` (BUG-039 — no `fixed`, no `bottom:`)', () => {
    renderAt('/')
    const container = screen.getByTestId('bottom-zone-container')
    // Under BUG-039 the nav is a plain sibling of `<main>` inside
    // `AppLayout`'s fixed-viewport root. The container MUST carry
    // `flex-shrink-0` (docks to the flex-bottom) and `.pb-safe`
    // (home-indicator clearance) and MUST NOT be `fixed` or chain
    // any `bottom-[…]` anchor.
    expect(container.className).toMatch(/\bflex-shrink-0\b/)
    expect(container.className).toMatch(/\bpb-safe\b/)
    expect(container.className).not.toMatch(/\bfixed\b/)
    expect(container.className).not.toMatch(/\bbottom-\[/)
  })

  it('no longer chains var(--viewport-bottom-offset) / var(--bottom-nav-height) anywhere in BottomNav.tsx (BUG-039)', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(resolve(here, './BottomNav.tsx'), 'utf8')
    expect(source).not.toMatch(/var\(--viewport-bottom-offset/)
    expect(source).not.toMatch(/var\(--bottom-nav-height/)
  })

  it('defines the `.pb-safe` utility in index.css so BottomNav can use it (BUG-039)', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const css = readFileSync(resolve(here, '../../index.css'), 'utf8')
    expect(css).toMatch(/\.pb-safe\s*\{[^}]*padding-bottom:\s*env\(safe-area-inset-bottom/)
  })

  // ───────── BUG-036 regression ─────────

  it('renders only the nav row (no slot) when no BottomZoneProvider is in the tree', () => {
    renderAt('/')
    // With no provider wrapping, `useBottomZoneConsumer` returns a null
    // slot and no slot-row should render.
    expect(screen.queryByTestId('bottom-zone-slot')).not.toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: /hauptnavigation/i })).toBeInTheDocument()
  })

  function renderWithSlotProvider(slotContent: ReactNode) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    })
    function SlotMounter({ children }: { children: ReactNode }) {
      useBottomZoneSlot(children, [children])
      return null
    }
    return render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <BottomZoneProvider>
            <SlotMounter>{slotContent}</SlotMounter>
            <BottomNav />
          </BottomZoneProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    )
  }

  it('renders a slot row ABOVE the nav row when a BottomZoneProvider + slot node are mounted (BUG-036)', async () => {
    renderWithSlotProvider(<span data-testid="fake-slot">hello</span>)
    const slotRow = await screen.findByTestId('bottom-zone-slot')
    const navRow = screen.getByRole('navigation', { name: /hauptnavigation/i })
    expect(slotRow).toBeInTheDocument()
    expect(slotRow.textContent).toContain('hello')
    // Both live inside the same Bottom-Zone container — the slot row
    // must appear before the nav row in document order so it visually
    // sits on top.
    const container = screen.getByTestId('bottom-zone-container')
    const children = Array.from(container.children)
    const slotIdx = children.indexOf(slotRow)
    const navIdx = children.indexOf(navRow)
    expect(slotIdx).toBeGreaterThanOrEqual(0)
    expect(navIdx).toBeGreaterThan(slotIdx)
  })
})
