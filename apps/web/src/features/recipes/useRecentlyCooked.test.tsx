import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { RecipeSummaryListDto } from '@familien-kochbuch/shared'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { useRecentlyCooked } from './useRecentlyCooked'

/**
 * PAGE-1 — Home page's "Zuletzt gekocht" now rides the paginated
 * recipe-list endpoint with `pageSize=5&sort=cooked_desc`. The hook is
 * a thin wrapper so the Home page does not import the recipe feature
 * internals directly.
 */
function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
  return Wrapper
}

describe('useRecentlyCooked', () => {
  beforeEach(() => {
    useAuthStore.getState().setSession('tok', {
      id: 'u1',
      email: 'x@y.de',
      displayName: 'X',
      role: 'User',
    })
  })
  afterEach(() => {
    server.resetHandlers()
    useAuthStore.getState().clear()
  })

  it('queries /recipes?sort=cooked_desc&pageSize=5 for the supplied group', async () => {
    let seenUrl = ''
    server.use(
      http.get('/api/groups/:groupId/recipes', ({ request, params }) => {
        seenUrl = request.url
        expect(params.groupId).toBe('g1')
        return HttpResponse.json<RecipeSummaryListDto>({
          items: [],
          page: 1,
          pageSize: 5,
          total: 0,
          hasNextPage: false,
          hasPrevPage: false,
        })
      }),
    )

    const { result } = renderHook(() => useRecentlyCooked('g1'), { wrapper: makeWrapper() })

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    expect(seenUrl).toContain('sort=cooked_desc')
    expect(seenUrl).toContain('pageSize=5')
  })

  it('is disabled when groupId is undefined — no request goes out', async () => {
    let called = false
    server.use(
      http.get('/api/groups/:groupId/recipes', () => {
        called = true
        return HttpResponse.json<RecipeSummaryListDto>({
          items: [],
          page: 1,
          pageSize: 5,
          total: 0,
          hasNextPage: false,
          hasPrevPage: false,
        })
      }),
    )

    const { result } = renderHook(() => useRecentlyCooked(undefined), { wrapper: makeWrapper() })
    // Give the query client a tick to potentially fire.
    await new Promise((r) => setTimeout(r, 10))

    expect(called).toBe(false)
    expect(result.current.fetchStatus).toBe('idle')
  })

  it('exposes the recipe summaries the API returns', async () => {
    server.use(
      http.get('/api/groups/:groupId/recipes', () =>
        HttpResponse.json<RecipeSummaryListDto>({
          items: [
            {
              id: 'r1',
              groupId: 'g1',
              title: 'Omas Schnitzel',
              description: null,
              photo: null,
              tagIds: [],
              createdByDisplayName: 'Oma',
              updatedAt: new Date().toISOString(),
              avgRating: 4.8,
              ratingCount: 5,
              myStars: null,
            },
          ],
          page: 1,
          pageSize: 5,
          total: 1,
          hasNextPage: false,
          hasPrevPage: false,
        }),
      ),
    )

    const { result } = renderHook(() => useRecentlyCooked('g1'), { wrapper: makeWrapper() })

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
    expect(result.current.data?.items[0]?.title).toBe('Omas Schnitzel')
    expect(result.current.data?.items).toHaveLength(1)
  })
})
