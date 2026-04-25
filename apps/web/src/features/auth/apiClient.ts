import type { AuthResponse } from '@shared-cookbook/shared'
import i18n from 'i18next'
import { useAuthStore } from './authStore'

/**
 * fetch wrapper that:
 *  - injects the current in-memory access token as `Authorization: Bearer …`
 *  - on 401, silently calls `/api/auth/refresh` exactly once and retries
 *    the original request with the new token
 *  - on refresh failure, clears the auth store and returns the original 401
 *  - refuses to recurse when the failing call IS the refresh endpoint
 *  - optionally sets an `If-Match` header (OFF4 optimistic-concurrency
 *    opt-in — callers that already know the server-side Version pass it
 *    through so the backend can reject a stale mutation with 409)
 *
 * Kept deliberately small — TanStack Query + the auth hooks sit on top
 * and can do higher-level error handling (redirect to login, toast, …).
 */
const REFRESH_URL = '/api/auth/refresh'

let refreshInFlight: Promise<string | null> | null = null

export function __resetApiClient(): void {
  refreshInFlight = null
}

/**
 * OFF4-compatible extension of `RequestInit`. The `ifMatch` field is
 * preferred over setting the `If-Match` header directly on `init.headers`
 * so upstream call-sites don't have to hand-build the ETag string — the
 * `ETagHelper.Compute(id, version)` convention lives in a tiny frontend
 * helper (`ifMatch.ts`) and callers just pipe its output through here.
 *
 * Every existing caller that doesn't pass `ifMatch` keeps the exact
 * behaviour it had before OFF4 — the header is only attached when the
 * field is present and non-empty.
 */
export interface ApiClientInit extends RequestInit {
  ifMatch?: string
}

export async function apiClient(
  input: RequestInfo | URL,
  init?: ApiClientInit,
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
  init?: ApiClientInit,
): Promise<Response> {
  const { accessToken } = useAuthStore.getState()
  const headers = new Headers(init?.headers)
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
  // OFF4 — attach If-Match when the caller supplied a non-empty value.
  // Backwards-compatible: callers without `ifMatch` continue working
  // exactly as before, and the header only lands on the wire when we
  // know the current cached Version.
  if (init?.ifMatch) headers.set('If-Match', init.ifMatch)
  // LANG-1 — propagate the user's UI language to the backend so the
  // .NET API + Python extractor's ``Accept-Language`` parsers see the
  // same value the user is reading. Idempotent: if the caller already
  // set their own ``Accept-Language`` header (rare; integration tests
  // pin it explicitly), we leave it alone. Reads ``i18n.language``
  // live on every request so the next API call after the user toggles
  // language reflects the new preference without a page reload. We
  // intentionally do NOT fall back to ``navigator.language`` here —
  // that path runs once at i18n init via REL-3h's detector chain;
  // running it twice would produce drift when the user's localStorage
  // override differs from the browser default.
  if (!headers.has('Accept-Language') && i18n.language) {
    headers.set('Accept-Language', i18n.language)
  }
  // TODO: CSRF hardening needed if cookie-based auth is added (today we
  // rely on Bearer tokens + SameSite=strict refresh cookie, so the
  // classic browser CSRF vector doesn't apply — revisit if that changes).
  // Strip the `ifMatch` key from the forwarded init — fetch() doesn't
  // know about it and some engines warn on unknown RequestInit fields.
  const { ifMatch: _omit, ...rest } = init ?? {}
  void _omit
  return fetch(input, { ...rest, headers, credentials: 'include' })
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
