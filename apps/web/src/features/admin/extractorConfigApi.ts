import type {
  ApiError,
  ExtractorConfigDetailResponse,
  ExtractorConfigItem,
  ExtractorConfigListResponse,
  PutExtractorConfigRequest,
} from '@familien-kochbuch/shared'
import { apiClient } from '@/features/auth/apiClient'

/**
 * CFG-2 thin HTTP layer for `/api/admin/extractor-config/*`. Mirrors
 * the `aiUsageApi` pattern — API errors are re-raised as plain Error
 * objects carrying a `code` + `message` so the React layer has one
 * stable shape to `catch` on and render German copy from.
 *
 * `updateExtractorConfig` + `resetExtractorConfig` both return the
 * post-update `ConfigItem`; the 409 / 400 branch is surfaced via the
 * thrown error's `code` field:
 *   - `version_mismatch` → UI refetches + shows "neu geladen" toast
 *   - `invalid_value`    → UI renders inline error under the field
 *   - anything else      → generic failure banner
 */
const BASE = '/api/admin/extractor-config'

export async function fetchExtractorConfigList(): Promise<ExtractorConfigListResponse> {
  return parseJsonOrThrow<ExtractorConfigListResponse>(await apiClient(`${BASE}/`))
}

export async function fetchExtractorConfigDetail(
  key: string,
): Promise<ExtractorConfigDetailResponse> {
  return parseJsonOrThrow<ExtractorConfigDetailResponse>(
    await apiClient(`${BASE}/${encodeURIComponent(key)}`),
  )
}

export async function updateExtractorConfig(
  key: string,
  body: PutExtractorConfigRequest,
): Promise<ExtractorConfigItem> {
  const response = await apiClient(`${BASE}/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return parseJsonOrThrow<ExtractorConfigItem>(response)
}

export async function resetExtractorConfig(
  key: string,
): Promise<ExtractorConfigItem> {
  const response = await apiClient(`${BASE}/${encodeURIComponent(key)}/reset`, {
    method: 'POST',
  })
  return parseJsonOrThrow<ExtractorConfigItem>(response)
}

async function parseJsonOrThrow<T>(response: Response): Promise<T> {
  if (!response.ok) {
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
  return (await response.json()) as T
}
