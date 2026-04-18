import { useEffect, useRef, useState } from 'react'
import type { AuthResponse, AuthUser } from '@familien-kochbuch/shared'
import { useAuthStore } from './authStore'

export type SessionStatus = 'loading' | 'authenticated' | 'anonymous'

/**
 * Boot-time silent refresh. Calls `/api/auth/refresh` exactly once on
 * mount to rehydrate the in-memory access token from the HTTP-only
 * refresh cookie. Until the round-trip settles, status = 'loading' so
 * `ProtectedRoute` can show a splash instead of flicker-redirecting.
 *
 * If the store already has a session (e.g. right after login/signup),
 * no refresh is fired — we go straight to 'authenticated'.
 */
export function useSession(): { status: SessionStatus; user: AuthUser | null } {
  const user = useAuthStore((s) => s.user)
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const setSession = useAuthStore((s) => s.setSession)
  const clear = useAuthStore((s) => s.clear)

  // 'tri-state' — 'loading' during the initial refresh round-trip,
  // 'settled' once that resolved one way or the other. Combined with the
  // store's isAuthenticated we derive the public SessionStatus below.
  const [bootPhase, setBootPhase] = useState<'loading' | 'settled'>(
    isAuthenticated ? 'settled' : 'loading',
  )
  const didBootRef = useRef(false)

  useEffect(() => {
    if (didBootRef.current) return
    didBootRef.current = true

    let cancelled = false

    void (async () => {
      // If we already have a session (e.g. right after login), skip the
      // network round-trip and settle immediately.
      if (isAuthenticated) {
        if (!cancelled) setBootPhase('settled')
        return
      }

      try {
        const response = await fetch('/api/auth/refresh', {
          method: 'POST',
          credentials: 'include',
        })
        if (cancelled) return
        if (response.ok) {
          const body = (await response.json()) as AuthResponse
          setSession(body.accessToken, body.user)
        } else {
          clear()
        }
      } catch {
        if (cancelled) return
        clear()
      } finally {
        if (!cancelled) setBootPhase('settled')
      }
    })()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally once on mount
  }, [])

  const status: SessionStatus =
    bootPhase === 'loading' ? 'loading' : isAuthenticated ? 'authenticated' : 'anonymous'

  return { status, user }
}
