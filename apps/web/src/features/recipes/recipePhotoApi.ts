import type { ApiError, UploadPhotoResponse } from '@familien-kochbuch/shared'
import { apiClient } from '@/features/auth/apiClient'

/**
 * UX1-PU — low-level multipart upload helper for recipe photos.
 *
 * Extracted out of `recipesApi.ts` so both `useUploadRecipePhoto` (edit
 * mode, via TanStack Query) and the create-mode form-submit orchestration
 * (plain await-loop after `createRecipe` resolves) can hit the same
 * code path with the same error normalisation.
 *
 * Error contract mirrors `recipesApi.request<T>()`: a thrown `Error`
 * augmented with `ApiError`-shaped `code`/`message` fields. 413 surfaces
 * with the backend's `photo_too_large` code, 5xx with whatever code the
 * backend emitted (or `http_<status>` as fallback).
 */
export async function uploadRecipePhoto(
  recipeId: string,
  file: File,
): Promise<UploadPhotoResponse> {
  const form = new FormData()
  form.append('file', file)
  const response = await apiClient(
    `/api/recipes/${encodeURIComponent(recipeId)}/photos`,
    { method: 'POST', body: form },
  )
  if (!response.ok) {
    let payload: ApiError | null = null
    try {
      payload = (await response.json()) as ApiError
    } catch {
      /* non-JSON body — fall through to status-based defaults */
    }
    const code = payload?.code ?? `http_${response.status}`
    const message = payload?.message ?? response.statusText
    const err = new Error(`${code}: ${message}`) as Error & ApiError
    err.code = code
    err.message = message
    throw err
  }
  return (await response.json()) as UploadPhotoResponse
}
