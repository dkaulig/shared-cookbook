import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { RecipeSearchResult } from '@shared-cookbook/shared'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { useRecipeSearch } from './hooks'

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

describe('useRecipeSearch', () => {
  it('forwards filter params and returns results', async () => {
    let url = ''
    server.use(
      http.get('/api/groups/g1/recipes/search', ({ request }) => {
        url = request.url
        return HttpResponse.json<RecipeSearchResult>({
          items: [
            {
              id: 'r1', groupId: 'g1', title: 'Nudeln',
              tagIds: [], createdByDisplayName: 'U',
              updatedAt: '2026-01-01T00:00:00Z',
              avgRating: 5, ratingCount: 1, myStars: 5,
            },
          ],
          page: 1, pageSize: 20, total: 1,
        })
      }),
    )

    const { result } = renderHook(
      () => useRecipeSearch('g1', { q: 'Nudeln', tags: ['t1'] }),
      { wrapper: makeWrapper() },
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(url).toContain('q=Nudeln')
    expect(url).toContain('tags=t1')
    expect(result.current.data?.items).toHaveLength(1)
  })

  it('is disabled when groupId is undefined', () => {
    const { result } = renderHook(() => useRecipeSearch(undefined, {}), {
      wrapper: makeWrapper(),
    })
    expect(result.current.fetchStatus).toBe('idle')
  })
})
