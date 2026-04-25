import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ApiError, AuthResponse } from '@shared-cookbook/shared'
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
    // Extra shared-device hygiene: sessionStorage keys seeded by app
    // features (shopping-list sort prefs, chat import memos, group-id
    // memo) are keyed by (user-owned) groupId/weekStart but survive
    // cross-user on the same tab if we don't sweep them. We use a
    // surgical prefix-sweep rather than `sessionStorage.clear()` so
    // non-app entries (if any third party ever shared the origin) stay
    // intact.
    purgeAppSessionStorage()
  }, [accessToken, clear, queryClient])

  return { accessToken, user, isAuthenticated, login, logout }
}

/**
 * App-known sessionStorage prefixes that must be swept on logout so the
 * next user on a shared device doesn't inherit prior state. Kept as a
 * named constant so grep from feature code ("where is this prefix
 * read?") lands here rather than a magic string in the `logout` hook.
 */
const APP_SESSION_STORAGE_PREFIXES = [
  'shopping-sort-', // ShoppingListPage sort toggle (per group, per week)
  'chat-import-', // chat → recipe import stash
  'import-group-', // URL/photo import groupId memo
] as const

function purgeAppSessionStorage(): void {
  // Gracefully no-op when sessionStorage is unavailable (Safari private
  // mode throws a generic DOMException on any read/write). Best-effort:
  // failing to sweep is a minor hygiene miss, not a correctness bug.
  try {
    const keysToDelete: string[] = []
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i)
      if (key && APP_SESSION_STORAGE_PREFIXES.some((p) => key.startsWith(p))) {
        keysToDelete.push(key)
      }
    }
    for (const key of keysToDelete) {
      sessionStorage.removeItem(key)
    }
  } catch {
    // Safari private mode / sandboxed iframe — nothing we can do here.
  }
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
  // REL-4: pin status + fieldName from the body so downstream
  // classifiers route by authoritative number.
  err.status = error?.status ?? response.status
  if (error?.fieldName) err.fieldName = error.fieldName
  throw err
}
