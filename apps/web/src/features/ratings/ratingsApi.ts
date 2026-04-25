import type {
  ApiError,
  RatingListResponse,
  UpsertRatingRequest,
  UpsertRatingResponse,
} from '@shared-cookbook/shared'
import { apiClient } from '@/features/auth/apiClient'

/**
 * Typed access layer for the S4 Rating API. Mirrors the recipesApi
 * pattern — `apiClient` injects the bearer token + handles silent refresh;
 * errors surface as throwable `ApiError`-shaped values.
 */

async function request<T>(input: RequestInfo | URL, init?: RequestInit, emptyResult?: T): Promise<T> {
  const response = await apiClient(input, init)
  if (!response.ok) {
    await throwApiError(response)
  }
  if (response.status === 204 || response.headers.get('Content-Length') === '0') {
    return (emptyResult as T) ?? (undefined as unknown as T)
  }
  return (await response.json()) as T
}

async function throwApiError(response: Response): Promise<never> {
  let payload: ApiError | null = null
  try {
    payload = (await response.json()) as ApiError
  } catch {
    /* non-JSON body — fall through */
  }
  const code = payload?.code ?? `http_${response.status}`
  const message = payload?.message ?? response.statusText
  const err = new Error(`${code}: ${message}`) as Error & ApiError
  err.code = code
  err.message = message
  // REL-4: pin status + fieldName from the body so downstream
  // classifiers route by authoritative number.
  err.status = payload?.status ?? response.status
  if (payload?.fieldName) err.fieldName = payload.fieldName
  throw err
}

export async function fetchRatings(recipeId: string): Promise<RatingListResponse> {
  return request<RatingListResponse>(`/api/recipes/${encodeURIComponent(recipeId)}/ratings`)
}

export async function upsertRating(
  recipeId: string,
  body: UpsertRatingRequest,
): Promise<UpsertRatingResponse> {
  return request<UpsertRatingResponse>(`/api/recipes/${encodeURIComponent(recipeId)}/ratings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function deleteRating(recipeId: string): Promise<void> {
  await request<void>(`/api/recipes/${encodeURIComponent(recipeId)}/ratings`, {
    method: 'DELETE',
  })
}
