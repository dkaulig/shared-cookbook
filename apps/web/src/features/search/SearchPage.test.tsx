import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { RecipeGlobalSearchResult } from '@familien-kochbuch/shared'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { SearchPage } from './SearchPage'

/**
 * SEARCH-1 — cross-group search page (`/suche`).
 *
 * Behaviour covered here:
 * - `?q=` missing → friendly empty-state, no fetch, sort Select hidden.
 * - Typing into the header <Input> debounces → URL gains `?q=…`.
 * - `?q=…` with 0 results → "Keine Treffer" empty-state.
 * - Sort <Select> changes → URL `?sort=…`, page resets to 1.
 * - Pagination renders when `total > pageSize`.
 * - Clicking a result card navigates to `/groups/{gid}/recipes/{rid}`.
 */
function renderAt(initialPath: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/suche" element={<LocationProbe>{children}</LocationProbe>} />
            <Route
              path="/groups/:gid/recipes/:rid"
              element={
                <LocationProbe>
                  <div data-testid="recipe-detail-stub">Rezept-Detail</div>
                </LocationProbe>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    )
  }
  return render(<SearchPage />, { wrapper: Wrapper })
}

function LocationProbe({ children }: { children: ReactNode }) {
  const location = useLocation()
  return (
    <>
      <div data-testid="current-path">{location.pathname}</div>
      <div data-testid="current-search">{location.search}</div>
      {children}
    </>
  )
}

function mockSearchResponse(
  overrides: Partial<RecipeGlobalSearchResult> = {},
): RecipeGlobalSearchResult {
  return {
    items: [],
    page: 1,
    pageSize: 24,
    total: 0,
    hasNextPage: false,
    hasPrevPage: false,
    query: '',
    ...overrides,
  }
}

describe('<SearchPage />', () => {
  beforeEach(() => {
    useAuthStore.setState({
      accessToken: 't',
      user: { id: 'u1', email: 'u1@ex.com', displayName: 'U', role: 'User' },
    })
  })
  afterEach(() => {
    server.resetHandlers()
    useAuthStore.getState().clear()
  })

  it('renders the empty-prompt when no q is in the URL — no backend call, sort hidden', () => {
    let hits = 0
    server.use(
      http.get('/api/recipes/search', () => {
        hits++
        return HttpResponse.json(mockSearchResponse())
      }),
    )
    renderAt('/suche')
    expect(
      screen.getByText(
        /tippe einen suchbegriff ein, um rezepte aus all deinen gruppen zu finden\./i,
      ),
    ).toBeInTheDocument()
    // The header sort <Select> is hidden until a query term exists.
    expect(screen.queryByLabelText(/sortierung/i)).toBeNull()
    expect(hits).toBe(0)
  })

  it('auto-focuses the search input on mount', () => {
    renderAt('/suche')
    const input = screen.getByPlaceholderText(/rezept suchen/i)
    expect(input).toHaveFocus()
  })

  it('commits typed text to the URL as ?q=… after the debounce', async () => {
    server.use(
      http.get('/api/recipes/search', () => HttpResponse.json(mockSearchResponse())),
    )
    renderAt('/suche')
    const user = userEvent.setup()
    const input = screen.getByPlaceholderText(/rezept suchen/i)
    await user.type(input, 'gochujang')

    await waitFor(
      () => {
        expect(screen.getByTestId('current-search')).toHaveTextContent(/q=gochujang/)
      },
      { timeout: 2000 },
    )
  })

  it('renders a "Keine Treffer" state when the backend returns zero items for a query', async () => {
    server.use(
      http.get('/api/recipes/search', () =>
        HttpResponse.json(mockSearchResponse({ total: 0, query: 'xyzxyz' })),
      ),
    )
    renderAt('/suche?q=xyzxyz')
    expect(
      await screen.findByText(/keine treffer für ['„]xyzxyz['"]/i),
    ).toBeInTheDocument()
  })

  it('exposes the five-option sort Select when q is set (SEARCH-1 enum)', async () => {
    server.use(
      http.get('/api/recipes/search', () =>
        HttpResponse.json(mockSearchResponse({ query: 'gochujang' })),
      ),
    )
    renderAt('/suche?q=gochujang')
    const select = await screen.findByLabelText(/sortierung/i)
    const values = Array.from(
      (select as HTMLSelectElement).querySelectorAll('option'),
    ).map((o) => o.value)
    expect(values).toEqual([
      'relevance_desc',
      'updated_desc',
      'cooked_desc',
      'title_asc',
      'rating_desc',
    ])
  })

  it('writes the sort pick to the URL and resets page=1', async () => {
    server.use(
      http.get('/api/recipes/search', () =>
        HttpResponse.json(mockSearchResponse({ query: 'gochujang' })),
      ),
    )
    renderAt('/suche?q=gochujang&page=3')
    const user = userEvent.setup()
    const select = await screen.findByLabelText(/sortierung/i)
    await user.selectOptions(select, 'title_asc')
    await waitFor(() => {
      const loc = screen.getByTestId('current-search').textContent ?? ''
      expect(loc).toContain('sort=title_asc')
      expect(loc).not.toContain('page=')
    })
  })

  it('renders a result card linking to /groups/{gid}/recipes/{rid} with a group-chip', async () => {
    server.use(
      http.get('/api/recipes/search', () =>
        HttpResponse.json(
          mockSearchResponse({
            items: [
              {
                id: 'r1',
                groupId: 'g1',
                groupName: 'Example Family',
                title: 'Gochujang-Nudeln',
                description: null,
                photo: null,
                tagIds: [],
                createdByDisplayName: 'David',
                updatedAt: '2026-04-01T00:00:00Z',
                avgRating: 4.5,
                ratingCount: 2,
                myStars: null,
              },
            ],
            total: 1,
            query: 'gochujang',
          }),
        ),
      ),
    )

    renderAt('/suche?q=gochujang')
    // Wait for the card to render.
    const recipeLink = await screen.findByRole('link', { name: /gochujang-nudeln/i })
    expect(recipeLink).toHaveAttribute('href', '/groups/g1/recipes/r1')

    // Group-chip is visible.
    const chip = screen.getByRole('link', { name: /example family/i })
    expect(chip).toHaveAttribute('href', '/groups/g1')
  })

  it('renders Pagination controls when total > pageSize', async () => {
    server.use(
      http.get('/api/recipes/search', () =>
        HttpResponse.json(
          mockSearchResponse({
            total: 50,
            page: 1,
            pageSize: 24,
            hasNextPage: true,
            query: 'gochujang',
            items: [
              {
                id: 'r1',
                groupId: 'g1',
                groupName: 'Example Family',
                title: 'Gochujang-Nudeln',
                description: null,
                photo: null,
                tagIds: [],
                createdByDisplayName: 'David',
                updatedAt: '2026-04-01T00:00:00Z',
                avgRating: null,
                ratingCount: 0,
                myStars: null,
              },
            ],
          }),
        ),
      ),
    )
    renderAt('/suche?q=gochujang')
    // Wait for the grid to render, then assert the pagination nav shows.
    await screen.findByRole('link', { name: /gochujang-nudeln/i })
    expect(await screen.findByLabelText(/seitennavigation/i)).toBeInTheDocument()
  })

  it('hides Pagination when total fits on a single page', async () => {
    server.use(
      http.get('/api/recipes/search', () =>
        HttpResponse.json(
          mockSearchResponse({
            total: 1,
            query: 'gochujang',
            items: [
              {
                id: 'r1',
                groupId: 'g1',
                groupName: 'Example Family',
                title: 'Gochujang-Nudeln',
                description: null,
                photo: null,
                tagIds: [],
                createdByDisplayName: 'David',
                updatedAt: '2026-04-01T00:00:00Z',
                avgRating: null,
                ratingCount: 0,
                myStars: null,
              },
            ],
          }),
        ),
      ),
    )
    renderAt('/suche?q=gochujang')
    await screen.findByRole('link', { name: /gochujang-nudeln/i })
    expect(screen.queryByLabelText(/seitennavigation/i)).toBeNull()
  })

  it('renders 24 skeleton placeholders while loading', async () => {
    // Delay the response so the loading state is stable long enough to
    // assert against.
    server.use(
      http.get(
        '/api/recipes/search',
        () =>
          new Promise((resolve) => {
            setTimeout(
              () => resolve(HttpResponse.json(mockSearchResponse({ query: 'gochujang' }))),
              200,
            )
          }),
      ),
    )
    renderAt('/suche?q=gochujang')
    const skeletons = await screen.findAllByTestId('search-skeleton-card')
    expect(skeletons.length).toBe(24)
  })
})
