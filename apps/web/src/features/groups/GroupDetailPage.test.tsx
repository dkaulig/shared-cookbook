import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { GroupDetail, RecipeSummaryDto } from '@familien-kochbuch/shared'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { GroupDetailPage } from './GroupDetailPage'

const detail: GroupDetail = {
  id: 'g1',
  name: 'Familie Müller',
  description: 'Unsere Lieblinge',
  coverImageUrl: null,
  defaultServings: 4,
  isPrivateCollection: false,
  memberCount: 2,
  myRole: 'Admin',
  members: [
    { userId: 'u1', displayName: 'Alice', role: 'Admin', joinedAt: '2026-04-18T00:00:00Z' },
    { userId: 'u2', displayName: 'Bob', role: 'Member', joinedAt: '2026-04-18T00:00:00Z' },
  ],
}

const schnitzel: RecipeSummaryDto = {
  id: 'r1',
  groupId: 'g1',
  title: 'Omas Schnitzel',
  description: null,
  photo: null,
  tagIds: [],
  createdByDisplayName: 'Oma',
  updatedAt: '2026-04-01T00:00:00Z',
  avgRating: 4.8,
  ratingCount: 12,
  myStars: null,
}

function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="location-probe">{loc.pathname}{loc.search}</div>
}

function withProviders(path: string): ReactNode {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 0 } },
  })
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/groups/:id"
            element={
              <>
                <GroupDetailPage />
                <LocationProbe />
              </>
            }
          />
          <Route
            path="/groups/:groupId/recipes/new"
            element={
              <>
                <div data-testid="recipe-new-page">new</div>
                <LocationProbe />
              </>
            }
          />
          <Route
            path="/groups/:groupId/recipes/:recipeId"
            element={
              <>
                <div data-testid="recipe-detail-page">detail</div>
                <LocationProbe />
              </>
            }
          />
          <Route path="/groups" element={<div data-testid="groups-list">list</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe('<GroupDetailPage />', () => {
  beforeEach(() => {
    useAuthStore.setState({
      accessToken: 't',
      user: { id: 'u1', email: 'u1@ex.de', displayName: 'Alice', role: 'User' },
    })
    server.use(
      http.get('/api/groups/g1', () => HttpResponse.json(detail)),
      http.get('/api/groups/g1/members', () => HttpResponse.json(detail.members)),
      http.get('/api/groups/g1/tags', () =>
        HttpResponse.json([
          {
            id: 't-quick',
            name: 'schnell',
            category: 'Aufwand',
            isGlobal: true,
            groupId: null,
            createdByUserId: null,
          },
        ]),
      ),
      // Default search response (empty list) so the list rendering doesn't
      // trigger network errors unrelated to the page-structure assertions.
      http.get('/api/groups/g1/recipes/search', () =>
        HttpResponse.json({ items: [], total: 0, page: 1, pageSize: 20 }),
      ),
    )
  })

  it('renders the group header with name, description, and stats', async () => {
    render(withProviders('/groups/g1'))
    expect(await screen.findByRole('heading', { level: 1, name: 'Familie Müller' })).toBeInTheDocument()
    expect(screen.getByText('Unsere Lieblinge')).toBeInTheDocument()
    // Default portions stat comes from defaultServings: 4
    expect(screen.getByText(/4 Portionen/)).toBeInTheDocument()
  })

  it('renders the DS4 filter bar (search, Filter toggle, Zufall)', async () => {
    render(withProviders('/groups/g1'))
    expect(await screen.findByRole('searchbox', { name: /suche/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Filter/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Zufall/ })).toBeInTheDocument()
  })

  it('renders the recipe grid when the search returns results', async () => {
    server.use(
      http.get('/api/groups/g1/recipes/search', () =>
        HttpResponse.json({ items: [schnitzel], total: 1, page: 1, pageSize: 20 }),
      ),
    )

    render(withProviders('/groups/g1'))
    expect(await screen.findByRole('link', { name: /Omas Schnitzel/ })).toBeInTheDocument()
    // Results header prints "<count> Rezepte in [Gruppe]" — we match the
    // "in Familie Müller" piece which is unique to that header.
    expect(screen.getByText(/in Familie Müller/)).toBeInTheDocument()
  })

  it('renders an empty state CTA when the group has zero recipes and no filters', async () => {
    render(withProviders('/groups/g1'))
    expect(
      await screen.findByText(/Noch keine Rezepte/i),
    ).toBeInTheDocument()
  })

  it('renders the "Kein Treffer" state when filters produce no results', async () => {
    render(withProviders('/groups/g1?q=Unfindbar'))
    expect(await screen.findByText(/Kein Treffer/i)).toBeInTheDocument()
  })

  it('clicking Zufall navigates to the returned random recipe', async () => {
    server.use(
      http.get('/api/groups/g1/recipes/random', () =>
        HttpResponse.json({ recipeId: 'r42' }),
      ),
    )

    render(withProviders('/groups/g1'))
    const zufall = await screen.findByRole('button', { name: /Zufall/ })
    const user = userEvent.setup()
    await user.click(zufall)

    await waitFor(() => {
      expect(screen.getByTestId('location-probe').textContent ?? '').toContain(
        '/groups/g1/recipes/r42',
      )
    })
  })

  it('Zufall surfaces a German message when no recipe matches', async () => {
    server.use(
      http.get('/api/groups/g1/recipes/random', () =>
        HttpResponse.json({ recipeId: null }),
      ),
    )

    render(withProviders('/groups/g1'))
    const zufall = await screen.findByRole('button', { name: /Zufall/ })
    const user = userEvent.setup()
    await user.click(zufall)

    expect(await screen.findByText(/Kein Rezept passt/i)).toBeInTheDocument()
  })

  it('FAB routes to the "new recipe" form', async () => {
    render(withProviders('/groups/g1'))
    const fab = await screen.findByRole('link', { name: /Neues Rezept/i })
    const user = userEvent.setup()
    await user.click(fab)

    await waitFor(() => {
      expect(screen.getByTestId('location-probe').textContent ?? '').toContain(
        '/groups/g1/recipes/new',
      )
    })
  })

  it('toggling the Filter button opens and closes the expanded filter panel', async () => {
    render(withProviders('/groups/g1'))
    const toggle = await screen.findByRole('button', { name: /^Filter/ })

    // Panel starts collapsed on the page → no filter UI yet.
    expect(screen.queryByLabelText(/Mindest-Bewertung/i)).not.toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(toggle)
    expect(await screen.findByLabelText(/Mindest-Bewertung/i)).toBeInTheDocument()

    await user.click(toggle)
    await waitFor(() => {
      expect(screen.queryByLabelText(/Mindest-Bewertung/i)).not.toBeInTheDocument()
    })
  })

  it('typing into the search box updates the URL (debounced)', async () => {
    render(withProviders('/groups/g1'))
    const search = await screen.findByRole('searchbox', { name: /suche/i })
    const user = userEvent.setup()
    await user.type(search, 'Schnitzel')

    await waitFor(() => {
      expect(screen.getByTestId('location-probe').textContent ?? '').toContain('q=Schnitzel')
    })
  })

  it('renders a collapsed "Mitglieder & Einladungen" toggle by default', async () => {
    render(withProviders('/groups/g1'))
    const toggle = await screen.findByRole('button', { name: /mitglieder.*einladungen/i })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    // Until expanded, the panel body isn't rendered.
    expect(
      screen.queryByRole('heading', { name: /mitglieder & einladungen/i, level: 2 }),
    ).not.toBeInTheDocument()
  })

  it('expanding the toggle reveals the members list', async () => {
    server.use(http.get('/api/groups/g1/invites', () => HttpResponse.json([])))
    render(withProviders('/groups/g1'))
    const toggle = await screen.findByRole('button', { name: /mitglieder.*einladungen/i })

    const user = userEvent.setup()
    await user.click(toggle)

    expect(
      await screen.findByRole('heading', { name: /mitglieder & einladungen/i, level: 2 }),
    ).toBeInTheDocument()
    const list = screen.getByRole('list', { name: /mitglieder/i })
    expect(list).toHaveTextContent('Alice')
    expect(list).toHaveTextContent('Bob')
  })

  // BUG-005 regression — the page sub-nav (back arrow + settings cog)
  // used to be `z-[9]`, which lost the stacking fight against the
  // `GroupDetailHeader` avatar (`z-10`). The avatar then overlapped the
  // back/settings tap-targets while scrolling. We standardise sub-navs
  // to `z-20` (same as the global TopNav) so they sit above any in-flow
  // avatars on the page.
  it('sticky sub-nav uses z-20 so it stays above page avatars (BUG-005)', async () => {
    render(withProviders('/groups/g1'))
    const subnav = await screen.findByRole('navigation', { name: /gruppen-navigation/i })
    expect(subnav.className).toContain('sticky')
    expect(subnav.className).toContain('top-[56px]')
    expect(subnav.className).toContain('z-20')
    // Belt-and-braces: the old z-[9] token is gone — otherwise the avatar
    // would slide back over the back-arrow + settings cog.
    expect(subnav.className).not.toContain('z-[9]')
  })

  // BUG-020 regression — the page used to render TWO links/buttons whose
  // accessible name matched /einstellungen/i: the top-bar cog (which
  // confusingly went to the tags page) and the GroupDetailHeader pill
  // (which goes to the actual settings page). The cog has been removed;
  // the pill is now the sole "Einstellungen" entry point.
  it('renders exactly one "Einstellungen" link (BUG-020)', async () => {
    render(withProviders('/groups/g1'))
    // Wait until the header has finished mounting (the pill is admin-only
    // and only shows after `useGroup` resolves).
    await screen.findByRole('heading', { level: 1, name: 'Familie Müller' })
    const matches = screen.getAllByRole('link', { name: /einstellungen/i })
    expect(matches).toHaveLength(1)
    // The remaining link is the GroupDetailHeader pill, which routes to
    // `/groups/:id/settings` (NOT `/groups/:id/tags`).
    expect(matches[0]).toHaveAttribute('href', '/groups/g1/settings')
  })

  it('top-bar sub-nav no longer contains a cog/settings link (BUG-020)', async () => {
    render(withProviders('/groups/g1'))
    const subnav = await screen.findByRole('navigation', { name: /gruppen-navigation/i })
    // The cog used to live inside the sub-nav — assert it's gone, both by
    // accessible name and by href to the now-redirected `/tags` path.
    const cogByLabel = subnav.querySelector('a[aria-label="Einstellungen"]')
    expect(cogByLabel).toBeNull()
    const cogByHref = subnav.querySelector('a[href="/groups/g1/tags"]')
    expect(cogByHref).toBeNull()
  })
})
