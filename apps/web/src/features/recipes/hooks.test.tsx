import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { useCreateRecipe, useGroupRecipes, useGroupTags, useRecipe } from './hooks'

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

describe('recipes hooks', () => {
  it('useGroupRecipes returns items from the API', async () => {
    server.use(
      http.get('/api/groups/g1/recipes', () =>
        HttpResponse.json({ items: [{ id: 'r1', title: 'R' }], page: 1, pageSize: 20, total: 1 }),
      ),
    )
    const { result } = renderHook(() => useGroupRecipes('g1'), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.items).toHaveLength(1)
  })

  it('useRecipe is disabled when id undefined', () => {
    const { result } = renderHook(() => useRecipe(undefined), { wrapper: makeWrapper() })
    expect(result.current.fetchStatus).toBe('idle')
  })

  it('useGroupTags returns tags', async () => {
    server.use(
      http.get('/api/groups/g1/tags', () =>
        HttpResponse.json([{ id: 't1', name: 'vegan', category: 'Diaet', isGlobal: true }]),
      ),
    )
    const { result } = renderHook(() => useGroupTags('g1'), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toHaveLength(1)
  })

  it('useCreateRecipe POSTs and resolves with detail', async () => {
    server.use(
      http.post('/api/groups/g1/recipes', () =>
        HttpResponse.json({ id: 'r1', title: 'Created' }, { status: 201 }),
      ),
    )
    const { result } = renderHook(() => useCreateRecipe('g1'), { wrapper: makeWrapper() })
    const detail = await result.current.mutateAsync({
      title: 'Created',
      defaultServings: 4,
      difficulty: 1,
      ingredients: [],
      steps: [],
      tagIds: [],
    })
    expect(detail.id).toBe('r1')
  })
})
