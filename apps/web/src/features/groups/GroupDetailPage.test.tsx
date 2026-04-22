import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { GroupDetail, RecipeSummaryDto } from '@familien-kochbuch/shared'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { GroupDetailPage } from './GroupDetailPage'
import { BottomZoneProvider } from '@/components/layout/bottomZone'
import { BottomNav } from '@/components/layout/BottomNav'

const detail: GroupDetail = {
  id: 'g1',
  name: 'Familie Müller',
  description: 'Unsere Lieblinge',
  coverImageUrl: null,
  defaultServings: 4,
  isPrivateCollection: false,
  memberCount: 2,
  myRole: 'Admin',
  version: 0,
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

/**
 * TABLET-1 — the recipe-detail routes are now nested children of
 * `/groups/:id`, so the test harness mirrors the real App.tsx route
 * tree: `GroupDetailPage` is the parent element, and the new/detail
 * routes render via its `<Outlet />`. Tests that want to probe the
 * post-navigation state just look at `LocationProbe` (outside the
 * parent) or the nested element's testid (inside the outlet).
 */
function RecipeDetailStub() {
  const params = useParams()
  return (
    <div data-testid="recipe-detail-page">detail {params.recipeId}</div>
  )
}

function withProviders(path: string): ReactNode {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 0 } },
  })
  // BUG-036 — the "Neues Rezept" CTA lives in the unified Bottom-Zone
  // slot now, so the test tree must mount <BottomZoneProvider> and
  // render <BottomNav> as a sibling for the slot to materialise.
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <BottomZoneProvider>
          <Routes>
            <Route
              path="/groups/:groupId"
              element={
                <>
                  <GroupDetailPage />
                  <LocationProbe />
                </>
              }
            >
              <Route path="recipes/:recipeId" element={<RecipeDetailStub />} />
            </Route>
            <Route
              path="/groups/:groupId/recipes/new"
              element={
                <>
                  <div data-testid="recipe-new-page">new</div>
                  <LocationProbe />
                </>
              }
            />
            <Route path="/groups" element={<div data-testid="groups-list">list</div>} />
          </Routes>
          <BottomNav />
        </BottomZoneProvider>
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

  // ─────────── PAGE-1 — Pagination + Sort ───────────

  it('renders the sort <Select> with the 4 supported German labels (PAGE-1)', async () => {
    // `cook_count_desc` was cut by PAGE-0 because neither a `TimesCooked`
    // column nor a `CookHistory` aggregation table exists yet; the
    // Select reflects that reality. Re-introduce the option when the
    // schema supports it.
    render(withProviders('/groups/g1'))
    const select = await screen.findByRole('combobox', { name: /sortierung/i })
    expect(select).toBeInTheDocument()
    const options = Array.from(
      (select as HTMLSelectElement).options,
      (o) => o.text,
    )
    expect(options).toEqual(
      expect.arrayContaining([
        'Zuletzt aktualisiert',
        'Zuletzt gekocht',
        'Titel A-Z',
        'Beste Bewertung',
      ]),
    )
    expect(options).not.toContain('Am häufigsten gekocht')
  })

  it('picking a sort writes ?sort=title_asc&page=1 to the URL (PAGE-1)', async () => {
    render(withProviders('/groups/g1?page=3'))
    const select = (await screen.findByRole('combobox', {
      name: /sortierung/i,
    })) as HTMLSelectElement
    const user = userEvent.setup()
    await user.selectOptions(select, 'title_asc')
    await waitFor(() => {
      const loc = screen.getByTestId('location-probe').textContent ?? ''
      expect(loc).toContain('sort=title_asc')
      // Sort change resets page → 1 (and the URL strips it when default).
      expect(loc).not.toContain('page=3')
    })
  })

  it('shows pagination nav + "Nächste Seite" when there is a next page (PAGE-1)', async () => {
    server.use(
      http.get('/api/groups/g1/recipes/search', () =>
        HttpResponse.json({
          items: [schnitzel],
          total: 72,
          page: 1,
          pageSize: 24,
          hasNextPage: true,
          hasPrevPage: false,
        }),
      ),
    )
    render(withProviders('/groups/g1'))
    await screen.findByRole('link', { name: /Omas Schnitzel/ })
    const next = await screen.findByRole('button', { name: /Nächste Seite/ })
    expect(next).toBeEnabled()
  })

  it('clicking next writes ?page=2 to the URL (PAGE-1)', async () => {
    server.use(
      http.get('/api/groups/g1/recipes/search', () =>
        HttpResponse.json({
          items: [schnitzel],
          total: 72,
          page: 1,
          pageSize: 24,
          hasNextPage: true,
          hasPrevPage: false,
        }),
      ),
    )
    render(withProviders('/groups/g1'))
    const next = await screen.findByRole('button', { name: /Nächste Seite/ })
    const user = userEvent.setup()
    await user.click(next)
    await waitFor(() => {
      expect(screen.getByTestId('location-probe').textContent ?? '').toContain(
        'page=2',
      )
    })
  })

  it('deep-link ?page=99 past the end shows an empty-state with a "Zur ersten Seite" link (PAGE-1)', async () => {
    server.use(
      http.get('/api/groups/g1/recipes/search', () =>
        HttpResponse.json({
          items: [],
          total: 48,
          page: 99,
          pageSize: 24,
          hasNextPage: false,
          hasPrevPage: true,
        }),
      ),
    )
    render(withProviders('/groups/g1?page=99'))
    expect(
      await screen.findByText(/Keine Rezepte auf dieser Seite/i),
    ).toBeInTheDocument()
    const back = screen.getByRole('link', { name: /Zur ersten Seite/i })
    // The href strips the `page` param — back on page 1 by default.
    // Relative-resolved, so it's either `/groups/g1` or `?` here; what
    // matters is that `page=99` isn't carried forward.
    expect(back.getAttribute('href') ?? '').not.toMatch(/page=99/)
    // Clicking it navigates to a URL without a page param.
    const user = userEvent.setup()
    await user.click(back)
    await waitFor(() => {
      const loc = screen.getByTestId('location-probe').textContent ?? ''
      expect(loc).not.toContain('page=99')
    })
  })

  // BUG-005 regression — the page sub-nav (back arrow + settings cog)
  // used to be `z-[9]`, which lost the stacking fight against the
  // `GroupDetailHeader` avatar (`z-10`). We now anchor sub-navs at
  // `z-10` (BUG-032 dropped from `z-20` so the global TopNav at `z-20`
  // clearly wins on any y-overlap during iOS/Chrome toolbar retract).
  // `z-10` still beats the old `z-[9]` avatar token.
  // BUG-042 — sticky offset is 0 now (<main> is the scroll container
  // per BUG-039, so its top already sits below TopNav). The older
  // BUG-032 assertion that expected `top-[var(--topnav-height)]` would
  // re-introduce the double-offset gap between TopNav and the sub-nav
  // while scrolled.
  it('sticky sub-nav uses top-0 + z-10 (BUG-042)', async () => {
    render(withProviders('/groups/g1'))
    const subnav = await screen.findByRole('navigation', { name: /gruppen-navigation/i })
    expect(subnav.className).toContain('sticky')
    expect(subnav.className).toMatch(/\btop-0\b/)
    expect(subnav.className).toContain('z-10')
    expect(subnav.className).not.toContain('top-[56px]')
    expect(subnav.className).not.toContain('top-[var(--topnav-height)]')
    expect(subnav.className).not.toContain('z-[9]')
  })

  // BUG-036 — the "Neues Rezept" CTA migrated from a standalone
  // fixed-bottom-right round FAB (BUG-032 z-40 + --bottom-nav-height
  // inline style) into the unified Bottom-Zone slot inside BottomNav.
  // The old fixed-positioning / inline-style are no longer our
  // problem — the slot row's single container handles chrome retract
  // tracking for ALL contextual actions at once. The contract this
  // test now guards is: the Link renders INSIDE the slot testid, it
  // points at `/recipes/new`, and it no longer carries any `fixed` /
  // inline `bottom` style of its own.
  it('"Neues Rezept" renders as a full-width button inside bottom-zone-slot (BUG-036)', async () => {
    render(withProviders('/groups/g1'))
    const link = await screen.findByRole('link', { name: /Neues Rezept/i })
    const slot = screen.getByTestId('bottom-zone-slot')
    expect(slot.contains(link)).toBe(true)
    expect(link).toHaveAttribute('href', '/groups/g1/recipes/new')
    // No standalone fixed positioning anymore — the wrapping BottomNav
    // owns that. The link itself is a flex child.
    expect(link.className).not.toMatch(/\bfixed\b/)
    expect((link as HTMLElement).style.bottom).toBe('')
    // Full-width-ish (flex-1) replacement for the old round FAB.
    expect(link.className).toMatch(/\bflex-1\b/)
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

  // ─────────── TABLET-1 — SplitPane adoption ───────────

  /**
   * At `md:+` the page layers its contents into a <SplitPane />: the
   * existing recipe list on the LEFT, an `<Outlet />` on the RIGHT.
   * The presence of both landmark regions (from <SplitPane />) plus
   * the unchanged list header is the contract.
   */
  it('renders the SplitPane landmark regions (Rezept-Liste + Rezept-Detail)', async () => {
    render(withProviders('/groups/g1'))
    await screen.findByRole('heading', { level: 1, name: 'Familie Müller' })
    // Right pane is `hidden md:block` so jsdom keeps it in the DOM but
    // hidden from the a11y tree; pass `hidden: true` to find it anyway.
    expect(screen.getByRole('region', { name: /rezept-liste/i })).toBeInTheDocument()
    expect(
      screen.getByRole('region', { name: /rezept-detail/i, hidden: true }),
    ).toBeInTheDocument()
  })

  it('shows an empty-state prompt in the detail slot when no recipe is selected', async () => {
    render(withProviders('/groups/g1'))
    await screen.findByRole('heading', { level: 1, name: 'Familie Müller' })
    const detailSlot = screen.getByRole('region', { name: /rezept-detail/i, hidden: true })
    // German copy — verified per feedback_tdd_default.md + project
    // language convention.
    expect(detailSlot.textContent ?? '').toMatch(
      /W(?:ä|ae)hle ein Rezept/i,
    )
  })

  it('renders the nested <Outlet /> inside the detail slot when a recipe route matches', async () => {
    server.use(
      http.get('/api/groups/g1/recipes/search', () =>
        HttpResponse.json({ items: [schnitzel], total: 1, page: 1, pageSize: 20 }),
      ),
    )
    render(withProviders('/groups/g1/recipes/r1'))
    const detailSlot = await screen.findByRole('region', {
      name: /rezept-detail/i,
      hidden: true,
    })
    const stub = await screen.findByTestId('recipe-detail-page')
    expect(detailSlot.contains(stub)).toBe(true)
    // Empty state should be gone once the outlet has content.
    expect(detailSlot.textContent ?? '').not.toMatch(/W(?:ä|ae)hle ein Rezept/i)
  })

  /**
   * 2026-04-21 slot-conflict fix: when the nested recipe route is
   * active, the parent GroupDetailPage must NOT push "Neues Rezept"
   * into the Bottom-Zone slot. Otherwise its effect overwrites the
   * child RecipeDetailPage's RecipeActionBar (React fires effects
   * bottom-up, so parent's setSlot runs AFTER child's and wins).
   * User-visible symptom before the fix: on a recipe detail page,
   * the bottom action bar showed "Neues Rezept" instead of
   * "Jetzt kochen" / "In Wochenplan" / "Jetzt gekocht".
   */
  it('does not push "Neues Rezept" into the slot while the nested recipe outlet is active', async () => {
    render(withProviders('/groups/g1/recipes/r1'))
    // Confirm we're on the nested route (the stub renders).
    await screen.findByTestId('recipe-detail-page')
    // Assert the parent's "Neues Rezept" Link is NOT in the DOM.
    // The child would be free to populate the slot with its own
    // RecipeActionBar; here we only guard against the parent's
    // overwrite.
    expect(screen.queryByRole('link', { name: /Neues Rezept/i })).toBeNull()
  })

  /**
   * Regression guard: on mobile, navigating from the nested recipe
   * route BACK to the bare group route must re-assert the "Neues
   * Rezept" slot. The parent GroupDetailPage stays mounted across
   * that navigation now (it owns the nested outlet), so the slot
   * effect MUST run on the outlet→null transition.
   */
  it('re-asserts the "Neues Rezept" bottom-zone slot when the outlet clears', async () => {
    const originalMatchMedia = window.matchMedia
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: query.includes('max-width: 767px'),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    })
    try {
      // MemoryRouter reads `initialEntries` only on mount, so
      // rerendering with a new path is a no-op. Unmount and mount
      // fresh for the bare-group URL — that's the realistic user
      // flow (navigate from `/groups/g1/recipes/r1` back to
      // `/groups/g1`) and exercises the parent's slot-re-assert.
      const first = render(withProviders('/groups/g1/recipes/r1'))
      await screen.findByTestId('recipe-detail-page')
      first.unmount()
      render(withProviders('/groups/g1'))
      const link = await screen.findByRole('link', { name: /Neues Rezept/i })
      expect(link).toHaveAttribute('href', '/groups/g1/recipes/new')
    } finally {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        writable: true,
        value: originalMatchMedia,
      })
    }
  })

  /**
   * Mobile fallback: when `useIsMobile()` reports true (viewport < md),
   * the page drops the SplitPane entirely so the nested outlet takes
   * over `<main>` as in the pre-TABLET-1 flow. The list is not rendered
   * alongside (would double-mount RecipeDetailPage and re-fetch data).
   */
  it('at < md (matchMedia reports mobile) the outlet replaces <main>, no SplitPane', async () => {
    const originalMatchMedia = window.matchMedia
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: query.includes('max-width: 767px'),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    })
    try {
      render(withProviders('/groups/g1/recipes/r1'))
      expect(await screen.findByTestId('recipe-detail-page')).toBeInTheDocument()
      // SplitPane regions are absent in mobile mode.
      expect(screen.queryByRole('region', { name: /rezept-liste/i })).toBeNull()
      expect(
        screen.queryByRole('region', { name: /rezept-detail/i, hidden: true }),
      ).toBeNull()
    } finally {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        writable: true,
        value: originalMatchMedia,
      })
    }
  })
})
