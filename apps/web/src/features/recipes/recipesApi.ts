import type {
  ApiError,
  CreateRecipeRequest,
  ForkRecipeRequest,
  ImportEnqueueResponse,
  NutritionEstimate,
  RecipeCoverSwapRequest,
  RecipeDetailDto,
  RecipeListSort,
  RecipeOriginImportResponse,
  RecipeSummaryListDto,
  RecipeTranslationResponse,
  ReimportRequest,
  TagDto,
  UpdateRecipeRequest,
  VersionMismatchError as VersionMismatchErrorBody,
} from '@shared-cookbook/shared'
import {
  DEFAULT_RECIPE_LIST_PAGE_SIZE,
  DEFAULT_RECIPE_LIST_SORT,
} from '@shared-cookbook/shared'
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
  // REL-4: pin status + fieldName from the body so downstream
  // classifiers route by authoritative number.
  err.status = payload?.status ?? response.status
  if (payload?.fieldName) err.fieldName = payload.fieldName
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

// ── Cover swap (COVER-0 Slice E) ──────────────────────────────────

/**
 * COVER-0 Slice E — swap the recipe's cover image.
 *
 * Accepts a `StagedPhoto.id` that must be either:
 *   - already promoted onto this recipe (re-order cheap path), OR
 *   - an un-promoted candidate of this recipe's origin-import
 *     (promote + swap in one server-side transaction).
 *
 * Error surface (server-mapped codes):
 *   - 400 `invalid_staged_photo_id` / `staged_photo_not_found` /
 *     `cover_wrong_owner` / `cover_not_from_recipe_import` /
 *     `cover_copy_failed` / `photo_limit_reached` / `cover_not_on_recipe`.
 *   - 403 `forbidden` — caller isn't the recipe owner.
 *   - 404 — missing recipe.
 *
 * Server also returns the refreshed `RecipeDetailDto` on success so the
 * TanStack-Query mutation can `setQueryData` straight into the detail
 * cache and the hero image re-renders without an extra GET.
 */
export async function swapRecipeCover(
  recipeId: string,
  body: RecipeCoverSwapRequest,
): Promise<RecipeDetailDto> {
  return request<RecipeDetailDto>(
    `/api/recipes/${encodeURIComponent(recipeId)}/cover`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  )
}

/**
 * COVER-0 Slice E — lookup the `RecipeImport.id` that produced this
 * recipe. Used by the RecipeDetailPage to decide whether to mount the
 * "Cover ändern" modal trigger.
 *
 * Returns `null` when the server answers 404 (manual recipe OR
 * every candidate has been consumed AND the recipe wasn't a reimport
 * target). Every other error class propagates — the detail page can
 * swallow it silently (missing button is the benign fallback) but the
 * API surface stays honest about non-404 failures.
 */
export async function fetchRecipeOriginImport(
  recipeId: string,
): Promise<RecipeOriginImportResponse | null> {
  try {
    return await request<RecipeOriginImportResponse>(
      `/api/recipes/${encodeURIComponent(recipeId)}/origin-import`,
    )
  } catch (err) {
    const apiErr = err as ApiError
    if (apiErr.code === 'http_404') return null
    throw err
  }
}

// ── Reimport (REIMPORT-1) ─────────────────────────────────────────

/**
 * REIMPORT-1 — enqueue a fresh extractor run against the recipe's saved
 * `sourceUrl`. The URL is read from the DB row server-side so a caller
 * can't redirect the extractor at another host. The caller must pass an
 * `If-Match` header derived from the cached recipe `version` so a stale
 * write fails with 409; typed `VersionMismatchError` surfaces for the
 * conflict-resolver UX (reload + retry).
 *
 * `body.aiNormalize` (default `false`) is the per-reimport opt-in for
 * LLM-based JSON-LD normalisation. Forwarded to the .NET endpoint and
 * on to the Python extractor as `force_llm`. An empty body / omitted
 * field is legal and defaults to off, matching the pre-toggle behaviour
 * exactly.
 */
export async function reimportRecipe(
  id: string,
  options?: { ifMatch?: string; body?: ReimportRequest },
): Promise<ImportEnqueueResponse> {
  return request<ImportEnqueueResponse>(
    `/api/recipes/${encodeURIComponent(id)}/reimport`,
    {
      method: 'POST',
      ifMatch: options?.ifMatch,
      headers: options?.body
        ? { 'Content-Type': 'application/json' }
        : undefined,
      body: options?.body ? JSON.stringify(options.body) : undefined,
    },
  )
}

/**
 * LANG-2 — POST /api/recipes/:id/translate?lang=de|en[&force=true]
 *
 * Triggers an on-demand re-translation. The server caches the result by
 * `(recipeId, language)` and returns the cached payload on repeat hits;
 * `force=true` re-runs the LLM even on a stale cache. Errors surface
 * via the standard ApiError pipeline:
 * - 400 `already_in_language` — target equals source language.
 * - 503 `ai_service_unavailable` — Azure timeout / parse failure.
 * - 503 `ai_disabled` — REL-7 OSS profile.
 */
export async function translateRecipe(
  id: string,
  lang: string,
  options?: { force?: boolean },
): Promise<RecipeTranslationResponse> {
  const params = new URLSearchParams({ lang })
  if (options?.force) params.set('force', 'true')
  return request<RecipeTranslationResponse>(
    `/api/recipes/${encodeURIComponent(id)}/translate?${params.toString()}`,
    { method: 'POST' },
  )
}

// ── Tags ────────────────────────────────────────────────────────────

export async function fetchGroupTags(groupId: string): Promise<TagDto[]> {
  return request<TagDto[]>(`/api/groups/${encodeURIComponent(groupId)}/tags`)
}
