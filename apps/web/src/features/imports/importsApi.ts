import type {
  ApiError,
  ExtractionResult,
  ImportEnqueueResponse,
  ImportPhotosRequest,
  ImportSourceKind,
  ImportStatus,
  ImportUrlRequest,
  RecipeImportDto,
} from '@familien-kochbuch/shared'
import { apiClient } from '@/features/auth/apiClient'

/**
 * Thin HTTP layer for the P2-7 URL-import flow.
 *
 * Talks to the P2-6 bridge endpoints:
 *   - POST /api/recipes/import/url  → returns { importId }.
 *   - GET  /api/imports/:importId   → returns the current RecipeImport
 *                                     state (polled every 2 s).
 *
 * The server serialises the `Status` and `Source` enums as TitleCase
 * (`"Queued"` / `"Url"`); we normalise them to lowercase at the edge
 * so the UI switches stay readable. The `result` field is a JSON
 * string on the wire and only set when `Status === "Done"`; we parse
 * it here so the React layer never has to touch the raw JSON.
 */

async function request<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await apiClient(input, init)
  if (!response.ok) {
    await throwApiError(response)
  }
  if (response.status === 204 || response.headers.get('Content-Length') === '0') {
    return undefined as unknown as T
  }
  return (await response.json()) as T
}

async function throwApiError(response: Response): Promise<never> {
  let payload: ApiError | null = null
  try {
    payload = (await response.json()) as ApiError
  } catch {
    /* non-JSON body — fall through. */
  }
  const code = payload?.code ?? `http_${response.status}`
  const message = payload?.message ?? response.statusText
  const err = new Error(`${code}: ${message}`) as Error & ApiError
  err.code = code
  err.message = message
  throw err
}

/**
 * Wire shape of `GET /api/imports/:id` — matches the .NET record
 * `ImportEndpoints.ImportStatusResponse`. Enum fields arrive as the
 * TitleCase enum name (`"Queued"`, `"Url"`) and `result` is either
 * `null` or a serialised JSON string. `mapStatusResponse` normalises
 * both.
 */
interface ImportStatusResponseWire {
  id: string
  source: string
  status: string
  progress: number
  sourceUrl: string | null
  result: string | null
  error: string | null
  createdAt: string
  completedAt: string | null
}

function normaliseStatus(raw: string): ImportStatus {
  const lower = raw.toLowerCase()
  if (lower === 'queued' || lower === 'running' || lower === 'done' || lower === 'error') {
    return lower
  }
  // Unknown enum name — surface as "error" so the UI shows the error
  // branch rather than polling forever.
  return 'error'
}

function normaliseSource(raw: string): ImportSourceKind {
  const lower = raw.toLowerCase()
  if (lower === 'url' || lower === 'photos' || lower === 'chat') {
    return lower
  }
  return 'url'
}

export function mapStatusResponse(wire: ImportStatusResponseWire): RecipeImportDto {
  let result: ExtractionResult | null = null
  if (wire.result != null) {
    try {
      result = JSON.parse(wire.result) as ExtractionResult
    } catch {
      // Bad JSON on the wire is a server bug — don't wedge the UI.
      // Leaving `result` null means the progress page falls through to
      // the error branch once status flips to "done" with no payload.
      result = null
    }
  }
  return {
    id: wire.id,
    source: normaliseSource(wire.source),
    status: normaliseStatus(wire.status),
    progress: wire.progress,
    sourceUrl: wire.sourceUrl,
    result,
    errorMessage: wire.error,
    createdAt: wire.createdAt,
    completedAt: wire.completedAt,
  }
}

/** Enqueue a URL-based import. Returns the new import id. */
export async function enqueueUrlImport(
  body: ImportUrlRequest,
): Promise<ImportEnqueueResponse> {
  return request<ImportEnqueueResponse>('/api/recipes/import/url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/**
 * Enqueue a photo-based import (P2-8). Body carries the ordered array of
 * signed photo URLs (each produced by `uploadStagedPhoto`) + the target
 * group. Server responds 202 with the new `{ importId }`.
 */
export async function enqueuePhotoImport(
  body: ImportPhotosRequest,
): Promise<ImportEnqueueResponse> {
  return request<ImportEnqueueResponse>('/api/recipes/import/photos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Fetch the current state of an import. Used by the polling query. */
export async function fetchImport(importId: string): Promise<RecipeImportDto> {
  const wire = await request<ImportStatusResponseWire>(
    `/api/imports/${encodeURIComponent(importId)}`,
  )
  return mapStatusResponse(wire)
}
