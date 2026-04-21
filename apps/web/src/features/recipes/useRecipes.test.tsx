import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { useRecipes } from './hooks'
import { recipeQueryKeys } from './queryKeys'

/**
 * PAGE-1 — paginated `useRecipes` hook tests.
 *
 * Contract covered:
 *  - Matches backend PAGE-0 endpoint shape:
 *    `GET /api/groups/:groupId/recipes?page&pageSize&sort` →
 *    `{ items, page, pageSize, total, hasNextPage, hasPrevPage }`.
 *  - Query key composition: `['recipes', groupId, page, sort]` by default;
 *    `pageSize` is only folded in when it differs from the default (24),
 *    so callers that stick with the grid-friendly default don't fragment
 *    the TanStack cache.
 *  - Cache-per-page: two independent `(page=1, page=2)` queries land in
 *    distinct cache entries so paging back doesn't refetch.
 */
beforeEach(() => {
  useAuthStore.setState({
    accessToken: 't',
    user: { id: 'u1', email: 'u1@example.com', displayName: 'U', role: 'User' },
  })
})

function makeWrapper(client?: QueryClient) {
  const qc =
    client ?? new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    ),
    client: qc,
  }
}

describe('useRecipes', () => {
  it('fetches the recipe list for the default page/sort and exposes hasNextPage/hasPrevPage', async () => {
    let hitUrl = ''
    server.use(
      http.get('/api/groups/g1/recipes', ({ request }) => {
        hitUrl = request.url
        return HttpResponse.json({
          items: [{ id: 'r1' }],
          page: 1,
          pageSize: 24,
          total: 30,
          hasNextPage: true,
          hasPrevPage: false,
        })
      }),
    )

    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useRecipes('g1'), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(hitUrl).toMatch(/\/api\/groups\/g1\/recipes\?/)
    expect(hitUrl).toContain('page=1')
    expect(hitUrl).toContain('pageSize=24')
    expect(hitUrl).toContain('sort=updated_desc')
    expect(result.current.data?.items).toHaveLength(1)
    expect(result.current.data?.hasNextPage).toBe(true)
    expect(result.current.data?.hasPrevPage).toBe(false)
  })

  it('encodes custom page + sort into the query string', async () => {
    let hitUrl = ''
    server.use(
      http.get('/api/groups/g1/recipes', ({ request }) => {
        hitUrl = request.url
        return HttpResponse.json({
          items: [],
          page: 3,
          pageSize: 24,
          total: 0,
          hasNextPage: false,
          hasPrevPage: true,
        })
      }),
    )

    const { wrapper } = makeWrapper()
    const { result } = renderHook(
      () => useRecipes('g1', { page: 3, sort: 'title_asc' }),
      { wrapper },
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(hitUrl).toContain('page=3')
    expect(hitUrl).toContain('sort=title_asc')
  })

  it('caches page 1 and page 2 independently (cache-per-page)', async () => {
    let calls = 0
    server.use(
      http.get('/api/groups/g1/recipes', ({ request }) => {
        calls += 1
        const url = new URL(request.url)
        const page = Number(url.searchParams.get('page') ?? '1')
        return HttpResponse.json({
          items: [{ id: `r-page-${page}` }],
          page,
          pageSize: 24,
          total: 48,
          hasNextPage: page === 1,
          hasPrevPage: page === 2,
        })
      }),
    )

    const { wrapper, client } = makeWrapper()
    const { result: p1 } = renderHook(() => useRecipes('g1', { page: 1 }), { wrapper })
    await waitFor(() => expect(p1.current.isSuccess).toBe(true))
    const { result: p2 } = renderHook(() => useRecipes('g1', { page: 2 }), { wrapper })
    await waitFor(() => expect(p2.current.isSuccess).toBe(true))

    expect(calls).toBe(2)
    expect(
      client.getQueryData(recipeQueryKeys.forGroup('g1', 1, 'updated_desc')),
    ).toBeTruthy()
    expect(
      client.getQueryData(recipeQueryKeys.forGroup('g1', 2, 'updated_desc')),
    ).toBeTruthy()
  })

  it('omits pageSize from the query key when the default (24) is used', () => {
    // Default pageSize → query key must NOT contain 24 as a trailing element,
    // so any consumer that doesn't override pageSize shares the same cache.
    const key = recipeQueryKeys.forGroup('g1', 1, 'updated_desc')
    expect(key).toEqual(['recipes', 'group', 'g1', 1, 'updated_desc'])
  })

  it('includes pageSize in the query key when non-default', () => {
    const key = recipeQueryKeys.forGroup('g1', 1, 'updated_desc', 100)
    expect(key).toEqual(['recipes', 'group', 'g1', 1, 'updated_desc', 100])
  })

  it('is disabled when groupId is undefined', () => {
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useRecipes(undefined), { wrapper })
    expect(result.current.fetchStatus).toBe('idle')
  })
})
