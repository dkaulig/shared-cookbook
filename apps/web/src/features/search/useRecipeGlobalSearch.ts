import { useQuery } from '@tanstack/react-query'
import type {
  GlobalSearchSort,
  RecipeGlobalSearchResult,
} from '@familien-kochbuch/shared'
import { apiClient } from '@/features/auth/apiClient'

/**
 * SEARCH-1 — cross-group recipe search hook.
 *
 * Wraps `GET /api/recipes/search?q=…&page=…&pageSize=…&sort=…`. The
 * endpoint scopes results to the caller's group memberships server-side
 * (see SEARCH-0) so the frontend never has to worry about foreign-group
 * leakage. The hook is deliberately gated behind `q.length >= 1` after
 * trim — the backend 400s empty `q` with `invalid_query`, and we don't
 * want the frontend to surface that as a generic error toast when the
 * user has simply cleared the input box. Empty → idle → show empty-state.
 *
 * Query-key shape is `['recipe-global-search', q, sort, page]` so the
 * TanStack-Query-persist wiring (OFF1) caches per-query. Stale-while-
 * revalidate on the page means a warm re-search flashes the previous
 * result before updating.
 *
 * The Authorization header is applied automatically by the shared
 * `apiClient` (Bearer token injection + 401-refresh replay).
 */
export interface GlobalSearchHookOptions {
  page?: number
  pageSize?: number
  sort?: GlobalSearchSort
}

export const globalSearchQueryKeys = {
  all: ['recipe-global-search'] as const,
  forQuery: (q: string, sort: GlobalSearchSort, page: number) =>
    [...globalSearchQueryKeys.all, q, sort, page] as const,
}

export function useRecipeGlobalSearch(
  q: string,
  { page = 1, pageSize = 24, sort = 'relevance_desc' }: GlobalSearchHookOptions,
) {
  const trimmed = q.trim()
  const enabled = trimmed.length >= 1

  return useQuery<RecipeGlobalSearchResult>({
    queryKey: globalSearchQueryKeys.forQuery(trimmed, sort, page),
    queryFn: () => fetchGlobalSearch(trimmed, { page, pageSize, sort }),
    enabled,
  })
}

async function fetchGlobalSearch(
  q: string,
  opts: Required<GlobalSearchHookOptions>,
): Promise<RecipeGlobalSearchResult> {
  const usp = new URLSearchParams()
  usp.set('q', q)
  usp.set('page', String(opts.page))
  usp.set('pageSize', String(opts.pageSize))
  usp.set('sort', opts.sort)
  const res = await apiClient(`/api/recipes/search?${usp.toString()}`)
  if (!res.ok) {
    let code = `http_${res.status}`
    let message = res.statusText
    try {
      const body = (await res.json()) as { code?: string; message?: string }
      if (body?.code) code = body.code
      if (body?.message) message = body.message
    } catch {
      /* non-JSON body — fall through */
    }
    const err = new Error(`${code}: ${message}`) as Error & { code?: string }
    err.code = code
    throw err
  }
  return (await res.json()) as RecipeGlobalSearchResult
}
