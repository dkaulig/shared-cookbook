import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { act, renderHook } from '@testing-library/react'
import { useAuth } from './useAuth'
import { useAuthStore } from './authStore'
import { server } from '@/test/msw/server'

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

    const { result } = renderHook(() => useAuth())
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

    const { result } = renderHook(() => useAuth())

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

    const { result } = renderHook(() => useAuth())
    await act(async () => {
      await result.current.logout()
    })

    expect(logoutCalled).toBe(true)
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
  })

  it('still clears the store when the server errors out', async () => {
    server.use(http.post('/api/auth/logout', () => new HttpResponse(null, { status: 500 })))

    const { result } = renderHook(() => useAuth())
    await act(async () => {
      await result.current.logout()
    })

    expect(useAuthStore.getState().isAuthenticated).toBe(false)
  })
})
