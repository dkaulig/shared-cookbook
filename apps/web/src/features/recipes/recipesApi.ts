import type {
  ApiError,
  CreateRecipeRequest,
  ForkRecipeRequest,
  RecipeDetailDto,
  RecipeSummaryListDto,
  TagDto,
  UpdateRecipeRequest,
  UploadPhotoResponse,
} from '@familien-kochbuch/shared'
import { apiClient } from '@/features/auth/apiClient'

/**
 * Typed access layer for the S3 Recipe API. All calls go through
 * `apiClient` so Bearer-token injection + silent refresh on 401 are
 * handled uniformly. Errors are normalised into a throwable
 * `ApiError`-shaped object.
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

// ── Recipes ─────────────────────────────────────────────────────────

export async function fetchGroupRecipes(
  groupId: string,
  page = 1,
  pageSize = 20,
): Promise<RecipeSummaryListDto> {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) })
  return request<RecipeSummaryListDto>(
    `/api/groups/${encodeURIComponent(groupId)}/recipes?${params.toString()}`,
  )
}

export async function fetchRecipe(id: string): Promise<RecipeDetailDto> {
  return request<RecipeDetailDto>(`/api/recipes/${encodeURIComponent(id)}`)
}

export async function createRecipe(groupId: string, body: CreateRecipeRequest): Promise<RecipeDetailDto> {
  return request<RecipeDetailDto>(`/api/groups/${encodeURIComponent(groupId)}/recipes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function updateRecipe(id: string, body: UpdateRecipeRequest): Promise<RecipeDetailDto> {
  return request<RecipeDetailDto>(`/api/recipes/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function deleteRecipe(id: string): Promise<void> {
  await request<void>(`/api/recipes/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// ── Photos ──────────────────────────────────────────────────────────

export async function uploadRecipePhoto(id: string, file: File): Promise<UploadPhotoResponse> {
  const form = new FormData()
  form.append('file', file)
  return request<UploadPhotoResponse>(`/api/recipes/${encodeURIComponent(id)}/photos`, {
    method: 'POST',
    body: form,
  })
}

export async function deleteRecipePhoto(id: string, url: string): Promise<void> {
  await request<void>(`/api/recipes/${encodeURIComponent(id)}/photos`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  })
}

// ── Fork ────────────────────────────────────────────────────────────

export async function forkRecipe(
  id: string,
  body: ForkRecipeRequest,
): Promise<RecipeDetailDto> {
  return request<RecipeDetailDto>(`/api/recipes/${encodeURIComponent(id)}/fork`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// ── Cook ────────────────────────────────────────────────────────────

/**
 * DS5 "Jetzt gekocht" — stamps `LastCookedAt` on the recipe with the
 * server's current clock and returns the refreshed detail DTO so the
 * UI (and the TanStack cache) can reflect the new timestamp without a
 * follow-up GET.
 */
export async function markRecipeAsCooked(id: string): Promise<RecipeDetailDto> {
  return request<RecipeDetailDto>(`/api/recipes/${encodeURIComponent(id)}/cook`, {
    method: 'POST',
  })
}

// ── Tags ────────────────────────────────────────────────────────────

export async function fetchGroupTags(groupId: string): Promise<TagDto[]> {
  return request<TagDto[]>(`/api/groups/${encodeURIComponent(groupId)}/tags`)
}
