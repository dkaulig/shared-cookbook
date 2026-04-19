import type { ApiError, StagedPhotoResponse } from '@familien-kochbuch/shared'
import { apiClient } from '@/features/auth/apiClient'

/**
 * P2-8 — thin multipart helper for the staged-photo upload endpoint.
 *
 * Posts a single `File` to `POST /api/recipes/photos/staged` and returns
 * the `{ photoId, signedUrl }` envelope the server emits. The caller is
 * `ImportPhotosPage` which collects the signed URLs and hands them in
 * order to `POST /api/recipes/import/photos`.
 *
 * Error contract mirrors `recipePhotoApi.uploadRecipePhoto`: a thrown
 * `Error` augmented with `ApiError`-shaped `code`/`message` fields so
 * callers can pattern-match on `code === 'unsupported_media_type'`,
 * `file_too_large`, etc. without inspecting HTTP status codes. 4xx
 * bodies pass through verbatim; non-JSON bodies fall back to
 * `http_<status>` + the default reason phrase.
 *
 * Deliberately doesn't wrap TanStack Query — `ImportPhotosPage` needs
 * strict sequential uploads (`for (const file of files) await …`) so
 * an n-at-a-time Promise.all would blow up the SeaweedFS filer on
 * spotty mobile connections. A plain async helper is the simplest shape
 * that enforces the serial pattern.
 */
export async function uploadStagedPhoto(file: File): Promise<StagedPhotoResponse> {
  const form = new FormData()
  form.append('file', file)
  const response = await apiClient('/api/recipes/photos/staged', {
    method: 'POST',
    body: form,
  })
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
  return (await response.json()) as StagedPhotoResponse
}
