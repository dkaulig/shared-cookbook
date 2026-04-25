import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAuthStore } from './authStore'
import type { AuthUser } from '@shared-cookbook/shared'

describe('useAuthStore', () => {
  beforeEach(() => {
    useAuthStore.getState().clear()
  })

  afterEach(() => {
    useAuthStore.getState().clear()
  })

  it('starts unauthenticated', () => {
    const state = useAuthStore.getState()
    expect(state.accessToken).toBeNull()
    expect(state.user).toBeNull()
    expect(state.isAuthenticated).toBe(false)
  })

  it('setSession stores access token + user and flips isAuthenticated', () => {
    const user: AuthUser = {
      id: '1de17f86-0c5a-4b60-9ddf-4b3ebcb2fdbb',
      email: 'user@example.com',
      displayName: 'Nutzer',
      role: 'User',
    }

    useAuthStore.getState().setSession('jwt.access.token', user)

    const state = useAuthStore.getState()
    expect(state.accessToken).toBe('jwt.access.token')
    expect(state.user).toEqual(user)
    expect(state.isAuthenticated).toBe(true)
  })

  it('clear resets both token and user', () => {
    useAuthStore.getState().setSession('tok', {
      id: 'x',
      email: 'x@y.z',
      displayName: 'X',
      role: 'Admin',
    })
    useAuthStore.getState().clear()

    const state = useAuthStore.getState()
    expect(state.accessToken).toBeNull()
    expect(state.user).toBeNull()
    expect(state.isAuthenticated).toBe(false)
  })

  it('access token is NOT persisted to localStorage (in-memory only)', () => {
    useAuthStore.getState().setSession('should-stay-in-memory', {
      id: 'x',
      email: 'x@y.z',
      displayName: 'X',
      role: 'User',
    })

    // Spec (PRD §10.7): access token lives in JS memory only — never in
    // localStorage / sessionStorage — to contain XSS blast radius.
    const keys = Object.keys(globalThis.localStorage ?? {})
    for (const key of keys) {
      const value = globalThis.localStorage.getItem(key) ?? ''
      expect(value).not.toContain('should-stay-in-memory')
    }
  })
})
