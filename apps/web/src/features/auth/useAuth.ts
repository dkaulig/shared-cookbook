import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ApiError, AuthResponse } from '@familien-kochbuch/shared'
import { useAuthStore } from './authStore'

/**
 * Component-facing auth API: exposes the current memory-backed session
 * plus login/logout primitives. Refresh is owned by `useSession` so the
 * app boot path stays in one place.
 */
export function useAuth() {
  const { accessToken, user, isAuthenticated, setSession, clear } = useAuthStore()
  const queryClient = useQueryClient()

  const login = useCallback(
    async (email: string, password: string): Promise<void> => {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })

      if (!response.ok) {
        await throwApiError(response)
      }

      const body = (await response.json()) as AuthResponse
      setSession(body.accessToken, body.user)
    },
    [setSession],
  )

  const logout = useCallback(async (): Promise<void> => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
      })
    } catch {
      // Swallow — local UX intent wins.
    }
    clear()
    // Shared-device hygiene: every cached query is user-scoped (groups,
    // mealplan, recipes…), so when user A logs out we must drop the
    // whole cache before user B can sign in. Otherwise user A's data
    // would flash for up to `staleTime` (30s) before the first refetch.
    // `clear()` removes both queries + mutations.
    queryClient.clear()
  }, [accessToken, clear, queryClient])

  return { accessToken, user, isAuthenticated, login, logout }
}

async function throwApiError(response: Response): Promise<never> {
  let error: ApiError | null = null
  try {
    error = (await response.json()) as ApiError
  } catch {
    // Non-JSON body (e.g. 500) — fall through to generic.
  }
  const code = error?.code ?? `http_${response.status}`
  const message = error?.message ?? response.statusText
  const err = new Error(`${code}: ${message}`) as Error & ApiError
  err.code = code
  err.message = message
  throw err
}
