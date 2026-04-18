import type {
  ApiError,
  RandomRecipeResponse,
  RecipeSearchParams,
  RecipeSearchResult,
} from '@familien-kochbuch/shared'
import { apiClient } from '@/features/auth/apiClient'

/**
 * Typed access layer for the S4 Search API. Mirrors the ratingsApi /
 * recipesApi pattern.
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
  throw err
}

/**
 * Serialises filter state into URL search params. Skips undefined / empty
 * fields so the backend sees only the active filters.
 */
export function buildSearchQueryString(params: RecipeSearchParams): string {
  const usp = new URLSearchParams()
  if (params.q && params.q.trim().length > 0) usp.set('q', params.q)
  if (params.tags && params.tags.length > 0) usp.set('tags', params.tags.join(','))
  if (params.minRating != null) usp.set('minRating', String(params.minRating))
  if (params.maxPrepTime != null) usp.set('maxPrepTime', String(params.maxPrepTime))
  if (params.createdBy) usp.set('createdBy', params.createdBy)
  if (params.sort) usp.set('sort', params.sort)
  if (params.page != null) usp.set('page', String(params.page))
  if (params.pageSize != null) usp.set('pageSize', String(params.pageSize))
  return usp.toString()
}

export async function searchRecipes(
  groupId: string,
  params: RecipeSearchParams,
): Promise<RecipeSearchResult> {
  const query = buildSearchQueryString(params)
  const url = `/api/groups/${encodeURIComponent(groupId)}/recipes/search${query ? `?${query}` : ''}`
  return request<RecipeSearchResult>(url)
}

export async function fetchRandomRecipe(
  groupId: string,
  params: RecipeSearchParams,
): Promise<RandomRecipeResponse> {
  const query = buildSearchQueryString(params)
  const url = `/api/groups/${encodeURIComponent(groupId)}/recipes/random${query ? `?${query}` : ''}`
  return request<RandomRecipeResponse>(url)
}
