import type { AuthResponse } from '@familien-kochbuch/shared'
import { useAuthStore } from './authStore'

/**
 * fetch wrapper that:
 *  - injects the current in-memory access token as `Authorization: Bearer …`
 *  - on 401, silently calls `/api/auth/refresh` exactly once and retries
 *    the original request with the new token
 *  - on refresh failure, clears the auth store and returns the original 401
 *  - refuses to recurse when the failing call IS the refresh endpoint
 *
 * Kept deliberately small — TanStack Query + the auth hooks sit on top
 * and can do higher-level error handling (redirect to login, toast, …).
 */
const REFRESH_URL = '/api/auth/refresh'

let refreshInFlight: Promise<string | null> | null = null

export function __resetApiClient(): void {
  refreshInFlight = null
}

export async function apiClient(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  const isRefreshCall = url.endsWith(REFRESH_URL)

  const response = await fetchWithAuth(input, init)
  if (response.status !== 401 || isRefreshCall) {
    return response
  }

  const newToken = await refreshAccessToken()
  if (newToken === null) {
    useAuthStore.getState().clear()
    return response
  }

  return fetchWithAuth(input, init)
}

async function fetchWithAuth(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const { accessToken } = useAuthStore.getState()
  const headers = new Headers(init?.headers)
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
  // TODO: CSRF hardening needed if cookie-based auth is added (today we
  // rely on Bearer tokens + SameSite=strict refresh cookie, so the
  // classic browser CSRF vector doesn't apply — revisit if that changes).
  return fetch(input, { ...init, headers, credentials: 'include' })
}

/**
 * Ensures at most one refresh request is in flight at a time — parallel
 * 401s from multiple concurrent API calls collapse onto a single refresh.
 */
async function refreshAccessToken(): Promise<string | null> {
  refreshInFlight ??= (async () => {
    try {
      const response = await fetch(REFRESH_URL, {
        method: 'POST',
        credentials: 'include',
      })
      if (!response.ok) return null
      const body = (await response.json()) as AuthResponse
      useAuthStore.getState().setSession(body.accessToken, body.user)
      return body.accessToken
    } catch {
      return null
    } finally {
      // Reset after the promise settles so the next 401 cycle can start fresh.
      queueMicrotask(() => {
        refreshInFlight = null
      })
    }
  })()
  return refreshInFlight
}
