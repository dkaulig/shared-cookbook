import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { useMyGroups } from './useMyGroups'

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

describe('useMyGroups', () => {
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

  it('returns the array from /api/groups on success', async () => {
    server.use(
      http.get('/api/groups', () =>
        HttpResponse.json([
          {
            id: 'g1',
            name: 'Familie',
            description: null,
            coverImageUrl: null,
            defaultServings: 2,
            isPrivateCollection: false,
            memberCount: 1,
            myRole: 'Admin',
            version: 0,
          },
        ]),
      ),
    )

    const { result } = renderHook(() => useMyGroups(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toHaveLength(1)
  })

  it('surfaces ApiError with code + message on 4xx', async () => {
    server.use(
      http.get('/api/groups', () =>
        HttpResponse.json({ code: 'auth_required', message: 'nope' }, { status: 401 }),
      ),
    )

    const { result } = renderHook(() => useMyGroups(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect((result.current.error as { code?: string })?.code).toBe('auth_required')
  })
})
