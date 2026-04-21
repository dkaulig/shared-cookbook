import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { RecipeGlobalSearchResult } from '@familien-kochbuch/shared'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { useRecipeGlobalSearch, globalSearchQueryKeys } from './useRecipeGlobalSearch'

/**
 * SEARCH-1 — cross-group search hook. Wraps TanStack Query on
 * `GET /api/recipes/search?q=…&page=…&pageSize=…&sort=…`. The hook is
 * gated behind `q.length >= 1` so an empty input box never hits the
 * backend (the endpoint 400s empty `q` — we don't want the frontend to
 * rely on that error for an empty state).
 */
beforeEach(() => {
  useAuthStore.setState({
    accessToken: 't',
    user: { id: 'u1', email: 'u1@ex.com', displayName: 'U', role: 'User' },
  })
})

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
}

describe('globalSearchQueryKeys', () => {
  it('composes keys as [root, q, sort, page] so per-query caching is stable', () => {
    const key = globalSearchQueryKeys.forQuery('gochujang', 'relevance_desc', 2)
    expect(key).toEqual(['recipe-global-search', 'gochujang', 'relevance_desc', 2])
  })
})

describe('useRecipeGlobalSearch', () => {
  it('is disabled (idle) when q is empty — no fetch, never surfaces the 400', () => {
    const { result } = renderHook(() => useRecipeGlobalSearch('', {}), {
      wrapper: makeWrapper(),
    })
    expect(result.current.fetchStatus).toBe('idle')
  })

  it('fires the GET with q + sort + page + pageSize when q is set', async () => {
    let capturedUrl = ''
    server.use(
      http.get('/api/recipes/search', ({ request }) => {
        capturedUrl = request.url
        return HttpResponse.json<RecipeGlobalSearchResult>({
          items: [],
          page: 1,
          pageSize: 24,
          total: 0,
          hasNextPage: false,
          hasPrevPage: false,
          query: 'gochujang',
        })
      }),
    )

    const { result } = renderHook(
      () =>
        useRecipeGlobalSearch('gochujang', {
          page: 2,
          pageSize: 24,
          sort: 'title_asc',
        }),
      { wrapper: makeWrapper() },
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(capturedUrl).toContain('q=gochujang')
    expect(capturedUrl).toContain('page=2')
    expect(capturedUrl).toContain('pageSize=24')
    expect(capturedUrl).toContain('sort=title_asc')
  })

  it('returns the group-aware items from the backend', async () => {
    server.use(
      http.get('/api/recipes/search', () =>
        HttpResponse.json<RecipeGlobalSearchResult>({
          items: [
            {
              id: 'r1',
              groupId: 'g1',
              groupName: 'Familie Kaulig',
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
          page: 1,
          pageSize: 24,
          total: 1,
          hasNextPage: false,
          hasPrevPage: false,
          query: 'gochujang',
        }),
      ),
    )

    const { result } = renderHook(() => useRecipeGlobalSearch('gochujang', {}), {
      wrapper: makeWrapper(),
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.items).toHaveLength(1)
    expect(result.current.data?.items[0]?.groupName).toBe('Familie Kaulig')
  })

  it('still gates on q.length >= 1 when only whitespace is supplied', () => {
    const { result } = renderHook(() => useRecipeGlobalSearch('   ', {}), {
      wrapper: makeWrapper(),
    })
    // Empty-after-trim is treated as empty; the gate holds.
    expect(result.current.fetchStatus).toBe('idle')
  })
})
