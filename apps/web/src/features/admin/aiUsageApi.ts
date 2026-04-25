import type { AiUsageGroupBy, AiUsageSummary, ApiError } from '@shared-cookbook/shared'
import { apiClient } from '@/features/auth/apiClient'

/**
 * Thin HTTP layer for `GET /api/admin/ai-usage`. Mirrors the pattern
 * used by `importsApi` — API errors are re-raised as Error objects
 * carrying a `code` + `message` so the React layer has a stable
 * shape to `catch` on.
 */

export interface FetchAiUsageParams {
  from?: string
  to?: string
  groupBy?: AiUsageGroupBy
}

export async function fetchAiUsage(
  params: FetchAiUsageParams = {},
): Promise<AiUsageSummary> {
  const search = new URLSearchParams()
  if (params.from) search.set('from', params.from)
  if (params.to) search.set('to', params.to)
  if (params.groupBy) search.set('groupBy', params.groupBy)

  const qs = search.toString()
  const path = qs ? `/api/admin/ai-usage?${qs}` : '/api/admin/ai-usage'

  const response = await apiClient(path)
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
    // REL-4: pin status + fieldName from the body so downstream
    // classifiers route by authoritative number.
    err.status = payload?.status ?? response.status
    if (payload?.fieldName) err.fieldName = payload.fieldName
    throw err
  }
  return (await response.json()) as AiUsageSummary
}
