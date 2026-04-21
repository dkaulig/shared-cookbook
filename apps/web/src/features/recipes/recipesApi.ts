import type {
  ApiError,
  CreateRecipeRequest,
  ForkRecipeRequest,
  ImportEnqueueResponse,
  NutritionEstimate,
  RecipeDetailDto,
  RecipeListSort,
  RecipeSummaryListDto,
  TagDto,
  UpdateRecipeRequest,
  VersionMismatchError as VersionMismatchErrorBody,
} from '@familien-kochbuch/shared'
import {
  DEFAULT_RECIPE_LIST_PAGE_SIZE,
  DEFAULT_RECIPE_LIST_SORT,
} from '@familien-kochbuch/shared'
import { apiClient } from '@/features/auth/apiClient'
import { VersionMismatchError } from '@/features/_shared/apiError'

// UX1-PU — the low-level multipart upload helper lives in its own module
// now so the create-mode form-submit orchestration can share it with the
// edit-mode hook. Re-export from here to keep the existing call-site
// (`import { uploadRecipePhoto } from './recipesApi'`) stable.
export { uploadRecipePhoto } from './recipePhotoApi'

/**
 * Typed access layer for the S3 Recipe API. All calls go through
 * `apiClient` so Bearer-token injection + silent refresh on 401 are
 * handled uniformly. Errors are normalised into a throwable
 * `ApiError`-shaped object.
 */

async function request<T>(
  input: RequestInfo | URL,
  init?: import('@/features/auth/apiClient').ApiClientInit,
  emptyResult?: T,
): Promise<T> {
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
  // OFF4 — 409 version_mismatch surfaces as a typed `VersionMismatchError`
  // so the UI resolver can narrow via `instanceof` without duplicating
  // status+code sniffing at every call site.
  if (response.status === 409 && code === 'version_mismatch') {
    const body = payload as unknown as VersionMismatchErrorBody | null
    throw new VersionMismatchError(message, body?.current ?? null)
  }
  const err = new Error(`${code}: ${message}`) as Error & ApiError
  err.code = code
  err.message = message
  throw err
}

// ── Recipes ─────────────────────────────────────────────────────────

/**
 * PAGE-1 — fetch a paginated + sorted slice of a group's recipes.
 * Options default to the backend's defaults (page 1, pageSize 24, sort
 * `updated_desc`) so all callers that don't care just get the first page
 * of the newest-updated recipes. The server clamps pageSize (1..100) and
 * 400s on unknown sorts — those bubble up as standard ApiError toasts.
 */
export async function fetchGroupRecipes(
  groupId: string,
  options: {
    page?: number
    pageSize?: number
    sort?: RecipeListSort
  } = {},
): Promise<RecipeSummaryListDto> {
  const page = options.page ?? 1
  const pageSize = options.pageSize ?? DEFAULT_RECIPE_LIST_PAGE_SIZE
  const sort = options.sort ?? DEFAULT_RECIPE_LIST_SORT
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
    sort,
  })
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

export async function updateRecipe(
  id: string,
  body: UpdateRecipeRequest,
  options?: { ifMatch?: string },
): Promise<RecipeDetailDto> {
  return request<RecipeDetailDto>(`/api/recipes/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ifMatch: options?.ifMatch,
  })
}

export async function deleteRecipe(id: string): Promise<void> {
  await request<void>(`/api/recipes/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// ── Photos ──────────────────────────────────────────────────────────
// `uploadRecipePhoto` lives in ./recipePhotoApi — re-exported at the top
// of this file so callers don't break.

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

// ── Nutrition (P2-10) ──────────────────────────────────────────────

/**
 * Patch the per-portion nutrition estimate. Pass `null` to clear, or a
 * populated `NutritionEstimate` to replace. Server enforces the same
 * bounds the domain record does; out-of-range values come back as a
 * 400 via `throwApiError`.
 */
export async function patchRecipeNutrition(
  id: string,
  body: NutritionEstimate | null,
): Promise<RecipeDetailDto> {
  return request<RecipeDetailDto>(
    `/api/recipes/${encodeURIComponent(id)}/nutrition`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  )
}

// ── Reimport (REIMPORT-1) ─────────────────────────────────────────

/**
 * REIMPORT-1 — enqueue a fresh extractor run against the recipe's saved
 * `sourceUrl`. The request body is intentionally empty: the server reads
 * the URL from the DB row so a caller can't redirect the extractor at
 * another host. The caller must pass an `If-Match` header derived from
 * the cached recipe `version` so a stale write fails with 409; typed
 * `VersionMismatchError` surfaces for the conflict-resolver UX (reload
 * + retry).
 */
export async function reimportRecipe(
  id: string,
  options?: { ifMatch?: string },
): Promise<ImportEnqueueResponse> {
  return request<ImportEnqueueResponse>(
    `/api/recipes/${encodeURIComponent(id)}/reimport`,
    {
      method: 'POST',
      ifMatch: options?.ifMatch,
    },
  )
}

// ── Tags ────────────────────────────────────────────────────────────

export async function fetchGroupTags(groupId: string): Promise<TagDto[]> {
  return request<TagDto[]>(`/api/groups/${encodeURIComponent(groupId)}/tags`)
}
