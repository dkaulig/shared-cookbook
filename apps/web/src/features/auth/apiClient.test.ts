import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import i18n from 'i18next'
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

  // ── LANG-1: Accept-Language reflects i18n.language ──────────────

  it('attaches Accept-Language: de when i18n.language is de', async () => {
    await i18n.changeLanguage('de')

    let captured: string | null = null
    server.use(
      http.get('/api/lang-probe', ({ request }) => {
        captured = request.headers.get('Accept-Language')
        return HttpResponse.json({ ok: true })
      }),
    )

    await apiClient('/api/lang-probe')
    expect(captured).toBe('de')
  })

  it('attaches Accept-Language: en after toggling i18n to en', async () => {
    await i18n.changeLanguage('de')

    let firstCaptured: string | null = null
    server.use(
      http.get('/api/lang-probe-1', ({ request }) => {
        firstCaptured = request.headers.get('Accept-Language')
        return HttpResponse.json({ ok: true })
      }),
    )
    await apiClient('/api/lang-probe-1')
    expect(firstCaptured).toBe('de')

    // Toggle — the next request must reflect the new value.
    await i18n.changeLanguage('en')

    let secondCaptured: string | null = null
    server.use(
      http.get('/api/lang-probe-2', ({ request }) => {
        secondCaptured = request.headers.get('Accept-Language')
        return HttpResponse.json({ ok: true })
      }),
    )
    await apiClient('/api/lang-probe-2')
    expect(secondCaptured).toBe('en')
  })

  it('does not overwrite a caller-provided Accept-Language', async () => {
    // Defensive: a caller (e.g. an integration that pins language for
    // tests) should be able to set their own header without the
    // interceptor stomping it.
    await i18n.changeLanguage('de')

    let captured: string | null = null
    server.use(
      http.get('/api/lang-probe-pin', ({ request }) => {
        captured = request.headers.get('Accept-Language')
        return HttpResponse.json({ ok: true })
      }),
    )

    await apiClient('/api/lang-probe-pin', {
      headers: { 'Accept-Language': 'en' },
    })
    expect(captured).toBe('en')
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
