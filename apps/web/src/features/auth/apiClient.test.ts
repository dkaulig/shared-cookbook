import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { apiClient, __resetApiClient } from './apiClient'
import { useAuthStore } from './authStore'
import { server } from '@/test/msw/server'

describe('apiClient', () => {
  beforeEach(() => {
    useAuthStore.getState().clear()
    __resetApiClient()
  })

  afterEach(() => {
    server.resetHandlers()
  })

  it('attaches Authorization header when an access token is stored', async () => {
    useAuthStore.getState().setSession('memory-access-token', {
      id: '1',
      email: 'a@b.c',
      displayName: 'A',
      role: 'User',
    })

    let capturedAuth: string | null = null
    server.use(
      http.get('/api/some-protected-thing', ({ request }) => {
        capturedAuth = request.headers.get('Authorization')
        return HttpResponse.json({ ok: true })
      }),
    )

    const res = await apiClient('/api/some-protected-thing')
    expect(res.ok).toBe(true)
    expect(capturedAuth).toBe('Bearer memory-access-token')
  })

  it('on 401 silently refreshes once, retries the request, and uses the new token', async () => {
    useAuthStore.getState().setSession('stale-token', {
      id: '1',
      email: 'a@b.c',
      displayName: 'A',
      role: 'User',
    })

    const authHeadersSeen: string[] = []
    server.use(
      http.get('/api/protected', ({ request }) => {
        const auth = request.headers.get('Authorization') ?? ''
        authHeadersSeen.push(auth)
        if (auth === 'Bearer stale-token') {
          return new HttpResponse(null, { status: 401 })
        }
        return HttpResponse.json({ ok: true })
      }),
      http.post('/api/auth/refresh', () =>
        HttpResponse.json({
          accessToken: 'fresh-token',
          user: { id: '1', email: 'a@b.c', displayName: 'A', role: 'User' },
        }),
      ),
    )

    const res = await apiClient('/api/protected')

    expect(res.ok).toBe(true)
    expect(authHeadersSeen).toEqual(['Bearer stale-token', 'Bearer fresh-token'])
    expect(useAuthStore.getState().accessToken).toBe('fresh-token')
  })

  it('on 401 with failing refresh clears the session and returns the 401', async () => {
    useAuthStore.getState().setSession('stale-token', {
      id: '1',
      email: 'a@b.c',
      displayName: 'A',
      role: 'User',
    })

    server.use(
      http.get('/api/protected', () => new HttpResponse(null, { status: 401 })),
      http.post('/api/auth/refresh', () => new HttpResponse(null, { status: 401 })),
    )

    const res = await apiClient('/api/protected')
    expect(res.status).toBe(401)
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
    expect(useAuthStore.getState().accessToken).toBeNull()
  })

  it('does NOT try to refresh the refresh endpoint itself', async () => {
    // If /api/auth/refresh itself returns 401, we must not loop back into
    // another refresh — just propagate.
    useAuthStore.getState().setSession('stale-token', {
      id: '1',
      email: 'a@b.c',
      displayName: 'A',
      role: 'User',
    })

    let refreshCalls = 0
    server.use(
      http.post('/api/auth/refresh', () => {
        refreshCalls += 1
        return new HttpResponse(null, { status: 401 })
      }),
    )

    const res = await apiClient('/api/auth/refresh', { method: 'POST' })
    expect(res.status).toBe(401)
    expect(refreshCalls).toBe(1)
  })
})
