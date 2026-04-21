import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
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
})
