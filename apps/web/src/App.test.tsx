import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import App from './App.tsx'
import { useAuthStore } from './features/auth/authStore.ts'
import { server } from './test/msw/server.ts'

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
  return render(<App />, { wrapper: Wrapper })
}

describe('<App />', () => {
  beforeEach(() => {
    useAuthStore.getState().clear()
    window.history.replaceState(null, '', '/')
  })

  afterEach(() => {
    server.resetHandlers()
  })

  it('redirects to /login when silent refresh fails', async () => {
    server.use(http.post('/api/auth/refresh', () => new HttpResponse(null, { status: 401 })))

    renderApp()

    await waitFor(() => {
      expect(window.location.pathname).toBe('/login')
    })
    // DS2 restyle: the h1 is the hero headline; the "Anmelden" label
    // lives on the card title + submit button.
    expect(
      screen.getByRole('heading', { level: 1, name: /was kochen wir heute\?/i }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^anmelden$/i })).toBeInTheDocument()
  })

  it('renders the Familien-Kochbuch home when silent refresh succeeds', async () => {
    server.use(
      http.post('/api/auth/refresh', () =>
        HttpResponse.json({
          accessToken: 'tok',
          user: { id: 'u1', email: 'user@example.com', displayName: 'Oma', role: 'User' },
        }),
      ),
      http.get('/api/groups', () => HttpResponse.json([])),
      http.get('/api/groups/invites', () => HttpResponse.json([])),
    )

    renderApp()

    // DS3 restyle: the h1 is the serif hero "Was kochen wir heute?";
    // the Familien-Kochbuch brand lives on the TopNav banner above it.
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { level: 1, name: /was kochen wir heute\?/i }),
      ).toBeInTheDocument()
    })
    // Brand lockup in the sticky TopNav.
    expect(screen.getByRole('banner')).toHaveTextContent(/familien-kochbuch/i)
    // Greeting kicker embeds the display name.
    expect(screen.getByText(/oma/i)).toBeInTheDocument()
  })

  // TABLET-1 — the recipe-detail route is now a CHILD of the group-
  // detail route so it can render inside the SplitPane's right pane.
  // Navigating directly to `/groups/:id/recipes/:recipeId` must still
  // resolve the full chain (protected → layout → group-detail → recipe)
  // without the URL bouncing to a 404.
  it('resolves the nested `/groups/:id/recipes/:recipeId` route without a 404', async () => {
    window.history.replaceState(null, '', '/groups/g1/recipes/r1')
    server.use(
      http.post('/api/auth/refresh', () =>
        HttpResponse.json({
          accessToken: 'tok',
          user: { id: 'u1', email: 'user@example.com', displayName: 'Oma', role: 'User' },
        }),
      ),
      http.get('/api/groups', () => HttpResponse.json([])),
      http.get('/api/groups/g1', () =>
        HttpResponse.json({
          id: 'g1',
          name: 'Familie Müller',
          description: null,
          coverImageUrl: null,
          defaultServings: 4,
          isPrivateCollection: false,
          memberCount: 1,
          myRole: 'Admin',
          version: 0,
          members: [],
        }),
      ),
      http.get('/api/groups/g1/members', () => HttpResponse.json([])),
      http.get('/api/groups/g1/tags', () => HttpResponse.json([])),
      http.get('/api/groups/g1/recipes/search', () =>
        HttpResponse.json({ items: [], total: 0, page: 1, pageSize: 20 }),
      ),
      http.get('/api/recipes/r1', () => new HttpResponse(null, { status: 404 })),
    )

    renderApp()

    await waitFor(() => {
      // URL stays on the nested recipe route (NotFoundPage would swap
      // it out for the 404 page — our recipe here 404s via API but the
      // route itself resolved, so the URL stays).
      expect(window.location.pathname).toBe('/groups/g1/recipes/r1')
    })
    // The 404 page has a very different shell — assert the GroupDetail
    // surface is mounted by looking for the sub-nav landmark.
    await waitFor(() => {
      expect(
        screen.getByRole('navigation', { name: /gruppen-navigation/i }),
      ).toBeInTheDocument()
    })
  })

  // 2026-04-22 slot-conflict regression — on a recipe detail page the
  // RecipeActionBar ("Jetzt kochen" / "In Wochenplan" / "Jetzt
  // gekocht") MUST be visible. Pre-fix the parent GroupDetailPage's
  // useBottomZoneSlot effect fired AFTER the child's (React's
  // bottom-up effect order) and overwrote the child's ActionBar with
  // null. A bare "Jetzt kochen"-button presence check at the App
  // level catches the regression — detail-page-only tests don't
  // exercise the nested-mount scenario.
  it('RecipeDetail action bar is visible when the recipe is reached via the nested route', async () => {
    window.history.replaceState(null, '', '/groups/g1/recipes/r1')
    server.use(
      http.post('/api/auth/refresh', () =>
        HttpResponse.json({
          accessToken: 'tok',
          user: { id: 'u1', email: 'user@example.com', displayName: 'Oma', role: 'User' },
        }),
      ),
      http.get('/api/groups', () => HttpResponse.json([])),
      http.get('/api/groups/g1', () =>
        HttpResponse.json({
          id: 'g1',
          name: 'Familie Müller',
          description: null,
          coverImageUrl: null,
          defaultServings: 4,
          isPrivateCollection: false,
          memberCount: 1,
          myRole: 'Admin',
          version: 0,
          members: [],
        }),
      ),
      http.get('/api/groups/g1/members', () => HttpResponse.json([])),
      http.get('/api/groups/g1/tags', () => HttpResponse.json([])),
      http.get('/api/groups/g1/recipes/search', () =>
        HttpResponse.json({ items: [], total: 0, page: 1, pageSize: 20 }),
      ),
      http.get('/api/recipes/r1', () =>
        HttpResponse.json({
          id: 'r1',
          groupId: 'g1',
          createdByUserId: 'u1',
          createdByDisplayName: 'Oma',
          title: 'Linsensuppe',
          description: null,
          defaultServings: 4,
          prepTimeMinutes: 15,
          difficulty: 1,
          sourceUrl: null,
          sourceType: 'Manual',
          forkOfRecipeId: null,
          photos: [],
          lastCookedAt: null,
          createdAt: '2026-04-22T00:00:00Z',
          updatedAt: '2026-04-22T00:00:00Z',
          version: 0,
          components: [
            { id: 'c1', position: 0, label: null, ingredients: [], steps: [] },
          ],
          tags: [],
          nutritionEstimate: null,
        }),
      ),
      http.get('/api/recipes/r1/revisions', () => HttpResponse.json([])),
    )

    renderApp()

    // The ActionBar's "Jetzt kochen" button lives inside the
    // bottom-zone slot inside BottomNav. Finding it proves the
    // child-owned slot survived the parent's effect pass.
    expect(
      await screen.findByRole('button', { name: /^Jetzt kochen$/i }),
    ).toBeInTheDocument()
    // Defensive: the parent's "Neues Rezept" link must NOT be in the
    // slot (parent yielded ownership).
    expect(
      screen.queryByRole('link', { name: /Neues Rezept anlegen/i }),
    ).not.toBeInTheDocument()
  })

  // 2026-04-22 nav-bug regression — clicking the RecipeDetail chevron-
  // back must land on the group's recipe list (/groups/:groupId), NOT
  // on the groups list (/groups). Pre-fix the nested-child's
  // useParams read `params.groupId = undefined` because the parent
  // route was declared as `:id`, so the back handler fired
  // `navigate("/groups/")` which React Router normalised to `/groups`.
  it('RecipeDetail chevron-back lands on the group detail, not on /groups', async () => {
    window.history.replaceState(null, '', '/groups/g1/recipes/r1')
    server.use(
      http.post('/api/auth/refresh', () =>
        HttpResponse.json({
          accessToken: 'tok',
          user: { id: 'u1', email: 'user@example.com', displayName: 'Oma', role: 'User' },
        }),
      ),
      http.get('/api/groups', () => HttpResponse.json([])),
      http.get('/api/groups/g1', () =>
        HttpResponse.json({
          id: 'g1',
          name: 'Familie Müller',
          description: null,
          coverImageUrl: null,
          defaultServings: 4,
          isPrivateCollection: false,
          memberCount: 1,
          myRole: 'Admin',
          version: 0,
          members: [],
        }),
      ),
      http.get('/api/groups/g1/members', () => HttpResponse.json([])),
      http.get('/api/groups/g1/tags', () => HttpResponse.json([])),
      http.get('/api/groups/g1/recipes/search', () =>
        HttpResponse.json({ items: [], total: 0, page: 1, pageSize: 20 }),
      ),
      http.get('/api/recipes/r1', () =>
        HttpResponse.json({
          id: 'r1',
          groupId: 'g1',
          createdByUserId: 'u1',
          createdByDisplayName: 'Oma',
          title: 'Linsensuppe',
          description: null,
          defaultServings: 4,
          prepTimeMinutes: 15,
          difficulty: 1,
          sourceUrl: null,
          sourceType: 'Manual',
          forkOfRecipeId: null,
          photos: [],
          lastCookedAt: null,
          createdAt: '2026-04-22T00:00:00Z',
          updatedAt: '2026-04-22T00:00:00Z',
          version: 0,
          components: [
            { id: 'c1', position: 0, label: null, ingredients: [], steps: [] },
          ],
          tags: [],
          nutritionEstimate: null,
        }),
      ),
      http.get('/api/recipes/r1/revisions', () => HttpResponse.json([])),
    )

    renderApp()

    const user = userEvent.setup()
    // Wait for the detail page to render, then click the chevron-back.
    const backBtn = await screen.findByRole('button', { name: /^Zurück$/i })
    await user.click(backBtn)
    await waitFor(() => {
      expect(window.location.pathname).toBe('/groups/g1')
    })
    // Defensive: the URL must NOT be the groups-list `/groups`.
    expect(window.location.pathname).not.toBe('/groups')
  })
})
