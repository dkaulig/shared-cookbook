import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { AppLayout } from './AppLayout'

function renderAt(initialPath: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[initialPath]}>{children}</MemoryRouter>
      </QueryClientProvider>
    )
  }
  return render(
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={<div data-testid="home-child">Home</div>} />
        <Route path="/groups" element={<div data-testid="groups-child">Groups</div>} />
        <Route
          path="/groups/:groupId/recipes/:recipeId"
          element={<div data-testid="recipe-child">Recipe</div>}
        />
        <Route
          path="/groups/:groupId/recipes/:recipeId/edit"
          element={<div data-testid="recipe-edit-child">Edit</div>}
        />
        <Route
          path="/groups/:groupId/recipes/new"
          element={<div data-testid="recipe-new-child">New</div>}
        />
      </Route>
    </Routes>,
    { wrapper: Wrapper },
  )
}

describe('<AppLayout />', () => {
  beforeEach(() => {
    useAuthStore.getState().setSession('tok', {
      id: 'u1',
      email: 'david@kaulig.de',
      displayName: 'David',
      role: 'User',
    })
    server.use(http.get('/api/groups/invites', () => HttpResponse.json([])))
  })
  afterEach(() => {
    server.resetHandlers()
    useAuthStore.getState().clear()
  })

  it('renders the routed child via <Outlet />', () => {
    renderAt('/')
    expect(screen.getByTestId('home-child')).toHaveTextContent('Home')
  })

  it('mounts the TopNav (banner + brand lockup)', () => {
    renderAt('/')
    expect(screen.getByRole('banner')).toHaveTextContent('Familien-Kochbuch')
  })

  it('mounts the BottomNav (navigation landmark with all five items)', () => {
    renderAt('/')
    expect(screen.getByRole('navigation', { name: /hauptnavigation/i })).toBeInTheDocument()
  })

  it('does NOT apply the parchment background (scoped to AuthLayout)', () => {
    const { container } = renderAt('/')
    expect(container.querySelector('.auth-parchment')).toBeNull()
  })

  // ───────── BUG-039 — hoppr-style flex-column layout ─────────

  it('wraps the shell in a `fixed inset-0 flex flex-col overflow-hidden` root', () => {
    const { container } = renderAt('/')
    // The outermost layout div carries the BUG-039 hoppr invariants:
    // fixed + flex-column + overflow-hidden so the document never scrolls.
    const root = container.firstElementChild as HTMLElement | null
    expect(root).not.toBeNull()
    expect(root?.className).toMatch(/\bfixed\b/)
    expect(root?.className).toMatch(/\binset-0\b/)
    expect(root?.className).toMatch(/\bflex\b/)
    expect(root?.className).toMatch(/\bflex-col\b/)
    expect(root?.className).toMatch(/\boverflow-hidden\b/)
  })

  it('`<main>` is the sole scroll container (flex-1 min-h-0 overflow-y-auto)', () => {
    const { container } = renderAt('/')
    const main = container.querySelector('main[data-app-shell="true"]')
    expect(main).not.toBeNull()
    expect(main?.className).toMatch(/\bflex-1\b/)
    expect(main?.className).toMatch(/\bmin-h-0\b/)
    expect(main?.className).toMatch(/\boverflow-y-auto\b/)
  })

  it('hides the shared TopNav on the recipe detail route (DS5 owns its own top bar)', () => {
    renderAt('/groups/g1/recipes/r1')
    // banner = <header role="banner"> in TopNav. Absent on recipe detail.
    expect(screen.queryByRole('banner')).toBeNull()
    expect(screen.getByTestId('recipe-child')).toBeInTheDocument()
  })

  it('hides the shared TopNav on the recipe edit route (DS6 form owns its own top bar)', () => {
    renderAt('/groups/g1/recipes/r1/edit')
    expect(screen.queryByRole('banner')).toBeNull()
    expect(screen.getByTestId('recipe-edit-child')).toBeInTheDocument()
  })

  it('hides the shared TopNav on the new-recipe route', () => {
    renderAt('/groups/g1/recipes/new')
    expect(screen.queryByRole('banner')).toBeNull()
    expect(screen.getByTestId('recipe-new-child')).toBeInTheDocument()
  })

  // ───────── TABLET-0 — SideRail wiring ─────────

  it('mounts the SideRail navigation landmark alongside the BottomNav', () => {
    renderAt('/')
    // Both nav landmarks exist in the DOM; Tailwind responsive classes
    // decide which is visible at the active viewport.
    expect(screen.getByRole('navigation', { name: /seitenleiste/i })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: /hauptnavigation/i })).toBeInTheDocument()
  })

  it('scopes the SideRail to the tablet zone via `hidden md:flex xl:hidden`', () => {
    renderAt('/')
    const rail = screen.getByRole('navigation', { name: /seitenleiste/i })
    // `hidden` at < md, `md:flex` from 768, `xl:hidden` from 1280+
    expect(rail.className).toMatch(/\bhidden\b/)
    expect(rail.className).toMatch(/\bmd:flex\b/)
    expect(rail.className).toMatch(/\bxl:hidden\b/)
  })

  it('renders <SideRail /> as a flex-sibling of <main> so the rail consumes width only when visible', () => {
    const { container } = renderAt('/')
    const main = container.querySelector('main[data-app-shell="true"]') as HTMLElement | null
    const rail = screen.getByRole('navigation', { name: /seitenleiste/i })
    expect(main).not.toBeNull()
    // Shared parent: the horizontal band between TopNav and BottomNav.
    expect(rail.parentElement).toBe(main?.parentElement)
    // That parent is the flex row carrying `flex-1 min-h-0` so SideRail
    // and <main> share the vertical axis between the top/bottom chrome.
    const band = rail.parentElement
    expect(band?.className).toMatch(/\bflex\b/)
    expect(band?.className).toMatch(/\bflex-1\b/)
    expect(band?.className).toMatch(/\bmin-h-0\b/)
  })

  it('keeps the hoppr-style `fixed inset-0 flex-col overflow-hidden` root intact with SideRail mounted (BUG-039 regression)', () => {
    const { container } = renderAt('/')
    const root = container.firstElementChild as HTMLElement | null
    expect(root).not.toBeNull()
    expect(root?.className).toMatch(/\bfixed\b/)
    expect(root?.className).toMatch(/\binset-0\b/)
    expect(root?.className).toMatch(/\bflex-col\b/)
    expect(root?.className).toMatch(/\boverflow-hidden\b/)
  })

  // ───────── TABLET-5 — DesktopTopNav wiring ─────────

  it('mounts the DesktopTopNav navigation landmark alongside the BottomNav + SideRail', () => {
    renderAt('/')
    // All three nav landmarks exist in the DOM at once; Tailwind
    // responsive classes decide which is visible at the active viewport.
    expect(
      screen.getByRole('navigation', { name: /desktop-navigation/i }),
    ).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: /seitenleiste/i })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: /hauptnavigation/i })).toBeInTheDocument()
  })

  it('scopes the DesktopTopNav to the desktop zone via `hidden xl:flex`', () => {
    renderAt('/')
    const nav = screen.getByRole('navigation', { name: /desktop-navigation/i })
    expect(nav.className).toMatch(/\bhidden\b/)
    expect(nav.className).toMatch(/\bxl:flex\b/)
  })

  it('renders DesktopTopNav as a flex-column sibling of the main band (not nested inside it)', () => {
    const { container } = renderAt('/')
    const root = container.firstElementChild as HTMLElement | null
    const desktopNav = screen.getByRole('navigation', { name: /desktop-navigation/i })
    // DesktopTopNav sits at the TOP of the flex-col shell, above the
    // horizontal band that hosts SideRail + <main>. It is a direct flex
    // child of the hoppr root (same parent as SideRail's wrapper band).
    expect(desktopNav.parentElement).toBe(root)
  })

  it('hides the DesktopTopNav on the recipe detail route (DS5 owns its own top bar)', () => {
    renderAt('/groups/g1/recipes/r1')
    expect(
      screen.queryByRole('navigation', { name: /desktop-navigation/i }),
    ).not.toBeInTheDocument()
  })

  it('hides the DesktopTopNav on the recipe edit + new routes (form owns its own top bar)', () => {
    renderAt('/groups/g1/recipes/r1/edit')
    expect(
      screen.queryByRole('navigation', { name: /desktop-navigation/i }),
    ).not.toBeInTheDocument()
    renderAt('/groups/g1/recipes/new')
    expect(
      screen.queryByRole('navigation', { name: /desktop-navigation/i }),
    ).not.toBeInTheDocument()
  })
})
