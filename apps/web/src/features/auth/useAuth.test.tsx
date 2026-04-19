import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useAuth } from './useAuth'
import { useAuthStore } from './authStore'
import { server } from '@/test/msw/server'

/**
 * Builds a QueryClientProvider wrapper so hook tests can share the
 * same client instance they assert on (logout clears this client).
 */
function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { client, Wrapper }
}

describe('useAuth.login', () => {
  beforeEach(() => {
    useAuthStore.getState().clear()
  })

  afterEach(() => {
    server.resetHandlers()
  })

  it('sets session on 200', async () => {
    server.use(
      http.post('/api/auth/login', async () =>
        HttpResponse.json({
          accessToken: 'login-token',
          user: { id: 'u1', email: 'user@example.com', displayName: 'Nutzer', role: 'User' },
        }),
      ),
    )

    const { Wrapper } = makeWrapper()
    const { result } = renderHook(() => useAuth(), { wrapper: Wrapper })
    await act(async () => {
      await result.current.login('user@example.com', 'passwort123')
    })

    expect(useAuthStore.getState().isAuthenticated).toBe(true)
    expect(useAuthStore.getState().accessToken).toBe('login-token')
    expect(useAuthStore.getState().user?.displayName).toBe('Nutzer')
  })

  it('throws on 401', async () => {
    server.use(
      http.post('/api/auth/login', () =>
        HttpResponse.json({ code: 'invalid_credentials', message: 'Ungültig' }, { status: 401 }),
      ),
    )

    const { Wrapper } = makeWrapper()
    const { result } = renderHook(() => useAuth(), { wrapper: Wrapper })

    await expect(
      act(async () => {
        await result.current.login('user@example.com', 'wrong')
      }),
    ).rejects.toThrow(/invalid_credentials|Ungültig/)

    expect(useAuthStore.getState().isAuthenticated).toBe(false)
  })
})

describe('useAuth.logout', () => {
  beforeEach(() => {
    useAuthStore.getState().setSession('t', {
      id: 'u1',
      email: 'x@y.z',
      displayName: 'X',
      role: 'User',
    })
  })

  afterEach(() => {
    server.resetHandlers()
    useAuthStore.getState().clear()
  })

  it('clears the store even if the server returns 204', async () => {
    let logoutCalled = false
    server.use(
      http.post('/api/auth/logout', () => {
        logoutCalled = true
        return new HttpResponse(null, { status: 204 })
      }),
    )

    const { Wrapper } = makeWrapper()
    const { result } = renderHook(() => useAuth(), { wrapper: Wrapper })
    await act(async () => {
      await result.current.logout()
    })

    expect(logoutCalled).toBe(true)
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
  })

  it('still clears the store when the server errors out', async () => {
    server.use(http.post('/api/auth/logout', () => new HttpResponse(null, { status: 500 })))

    const { Wrapper } = makeWrapper()
    const { result } = renderHook(() => useAuth(), { wrapper: Wrapper })
    await act(async () => {
      await result.current.logout()
    })

    expect(useAuthStore.getState().isAuthenticated).toBe(false)
  })

  // Shared-device hygiene: user A logs out → user B logs in → user B
  // must never see user A's cached groups/mealplan/recipes. Clearing
  // the react-query cache on logout is the belt-and-braces guardrail.
  it('purges the react-query cache on logout', async () => {
    server.use(
      http.post('/api/auth/logout', () => new HttpResponse(null, { status: 204 })),
    )

    const { client, Wrapper } = makeWrapper()
    // Seed a user-scoped cache entry the way TanStack-Query stores it
    // in production: a real QueryKey + pre-populated data.
    client.setQueryData(['mealplan', 'group-1', '2026-04-13'], { dummy: true })
    expect(client.getQueryData(['mealplan', 'group-1', '2026-04-13'])).toEqual({
      dummy: true,
    })

    const { result } = renderHook(() => useAuth(), { wrapper: Wrapper })
    await act(async () => {
      await result.current.logout()
    })

    expect(useAuthStore.getState().isAuthenticated).toBe(false)
    expect(client.getQueryData(['mealplan', 'group-1', '2026-04-13'])).toBeUndefined()
    expect(client.getQueryCache().getAll()).toHaveLength(0)
  })

  // Shared-device hygiene follow-up: sessionStorage keys seeded by app
  // features outlive `queryClient.clear()`, so on the same tab user B
  // would otherwise inherit user A's sort prefs / import memos. Sweep
  // known app prefixes on logout; leave foreign keys intact.
  it('purges app-prefixed sessionStorage keys on logout', async () => {
    server.use(
      http.post('/api/auth/logout', () => new HttpResponse(null, { status: 204 })),
    )

    sessionStorage.setItem('shopping-sort-group-1-2026-04-13', 'by-category')
    sessionStorage.setItem('chat-import-sess-abc', JSON.stringify({ stub: 1 }))
    sessionStorage.setItem('import-group-xyz', 'group-1')
    // Foreign key must survive — we're surgical, not nuclear.
    sessionStorage.setItem('unrelated-foreign-key', 'keep-me')

    const { Wrapper } = makeWrapper()
    const { result } = renderHook(() => useAuth(), { wrapper: Wrapper })
    await act(async () => {
      await result.current.logout()
    })

    expect(sessionStorage.getItem('shopping-sort-group-1-2026-04-13')).toBeNull()
    expect(sessionStorage.getItem('chat-import-sess-abc')).toBeNull()
    expect(sessionStorage.getItem('import-group-xyz')).toBeNull()
    expect(sessionStorage.getItem('unrelated-foreign-key')).toBe('keep-me')

    // Clean up the foreign key so other tests don't see it.
    sessionStorage.removeItem('unrelated-foreign-key')
  })
})
