import type {
  ApiError,
  RecipeRevisionDetail,
  RecipeRevisionSummary,
} from '@shared-cookbook/shared'
import { apiClient } from '@/features/auth/apiClient'

/**
 * Typed access layer for the S6 recipe-revision endpoints. Mirrors the
 * `recipesApi` pattern: every call goes through `apiClient` so 401-retry
 * + Bearer-token injection work uniformly, and non-2xx responses are
 * normalised to a throwable `ApiError`.
 */

async function request<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await apiClient(input, init)
  if (!response.ok) {
    await throwApiError(response)
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

export async function fetchRecipeRevisions(recipeId: string): Promise<RecipeRevisionSummary[]> {
  return request<RecipeRevisionSummary[]>(
    `/api/recipes/${encodeURIComponent(recipeId)}/revisions`,
  )
}

export async function fetchRecipeRevision(
  recipeId: string,
  revisionId: string,
): Promise<RecipeRevisionDetail> {
  return request<RecipeRevisionDetail>(
    `/api/recipes/${encodeURIComponent(recipeId)}/revisions/${encodeURIComponent(revisionId)}`,
  )
}
