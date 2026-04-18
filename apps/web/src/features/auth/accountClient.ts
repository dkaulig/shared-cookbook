import type {
  ApiError,
  AuthUser,
  ChangeDisplayNameRequest,
  ChangePasswordRequest,
} from '@familien-kochbuch/shared'
import { apiClient } from './apiClient'

/**
 * Type-safe wrappers around the /api/account/* endpoints introduced by
 * AP1. Both methods go through {@link apiClient} so the Authorization
 * header + silent-refresh behaviour is inherited.
 *
 * Errors are thrown as `Error & ApiError` so callers can `catch` and
 * switch on `.code` to surface a matching German message.
 */

/**
 * POST /api/account/change-password. Resolves on 204. On 400/401 throws
 * an Error whose `code` + `message` mirror the server's ErrorResponse
 * envelope.
 */
export async function changePassword(request: ChangePasswordRequest): Promise<void> {
  const response = await apiClient('/api/account/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })

  if (!response.ok) {
    await throwApiError(response)
  }
}

/**
 * PATCH /api/account/display-name. Resolves with the updated
 * {@link AuthUser} so callers can push it into the auth store without a
 * second round-trip.
 */
export async function changeDisplayName(
  request: ChangeDisplayNameRequest,
): Promise<AuthUser> {
  const response = await apiClient('/api/account/display-name', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })

  if (!response.ok) {
    await throwApiError(response)
  }

  return (await response.json()) as AuthUser
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
