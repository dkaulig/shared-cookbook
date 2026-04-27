import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  ImportCandidate,
  ImportEnqueueResponse,
  ImportPhotosRequest,
  ImportSummaryDto,
  ImportUrlRequest,
  RecipeImportDto,
} from '@shared-cookbook/shared'
import {
  enqueuePhotoImport,
  enqueueUrlImport,
  fetchImport,
  fetchImportCandidates,
  fetchMyImports,
  retryImport,
} from './importsApi'
import { readImportLiveEventAt } from './liveEventTimestamp'

/**
 * Query-key family for the imports feature. The progress page uses
 * `status(importId)` for its polling query; the URL form has no query,
 * only a mutation. The SignalR handler in `useLiveSync` writes to the
 * same key via `setQueryData` so both paths converge on one cache
 * entry.
 */
export const importQueryKeys = {
  all: ['imports'] as const,
  status: (importId: string) => ['imports', 'status', importId] as const,
  /**
   * BUG-010 — key for the caller's own list of recent imports. Separate
   * from {@link status} so mutating one status cache entry doesn't
   * accidentally invalidate the list view.
   */
  mine: (limit: number) => ['imports', 'mine', limit] as const,
  /**
   * COVER-0 — freshly-signed cover-candidate URLs for a specific
   * import. Separate family from {@link status} so the form page /
   * detail page can invalidate candidate signatures independently
   * of the import status cache.
   */
  candidates: (importId: string) =>
    ['imports', 'candidates', importId] as const,
}

/**
 * PV3 — default poll cadence bumped to 3 s (was 2 s). SignalR is the
 * primary transport for progress updates now; polling is fallback for
 * disconnected-hub / tab-hidden / out-of-sequence scenarios.
 */
export const DEFAULT_IMPORT_POLL_MS = 3000

/**
 * PV3 — when a SignalR event landed within this window we SKIP the
 * next poll cycle. The cache is already authoritative (setQueryData
 * applied the event payload directly) so a poll would be pure waste.
 * Kept at 2s so the first poll after the SignalR hub disconnects still
 * fires within one 3s cycle.
 */
export const SIGNALR_FRESH_WINDOW_MS = 2000

/**
 * Mutation wrapper around `POST /api/recipes/import/url`.
 *
 * The caller supplies `{ url, groupId }` on submit; we return the fresh
 * `{ importId }` so the URL form can navigate to `/rezepte/import/:id`.
 */
export function useEnqueueUrlImport() {
  return useMutation<ImportEnqueueResponse, Error, ImportUrlRequest>({
    mutationFn: (body) => enqueueUrlImport(body),
  })
}

/**
 * Mutation wrapper around `POST /api/recipes/import/photos` (P2-8).
 *
 * The caller is `ImportPhotosPage`, which has already uploaded each
 * staged photo to SeaweedFS and now hands the ordered array of signed
 * URLs back to the bridge endpoint. We return the fresh `{ importId }`
 * so the page can navigate to the shared progress page.
 */
export function useEnqueuePhotoImport() {
  return useMutation<ImportEnqueueResponse, Error, ImportPhotosRequest>({
    mutationFn: (body) => enqueuePhotoImport(body),
  })
}

interface UseImportStatusOptions {
  /** Override the default 3 s poll cadence (e.g. tighter in tests). */
  refetchInterval?: number
  /** Disable the query entirely — useful in tests or when the id is empty. */
  enabled?: boolean
  /**
   * BUG-017 — passthrough to TanStack Query's `refetchOnMount`. Let the
   * caller force a fresh fetch when mounting (e.g. `RecipeFormPage` uses
   * `'always'` to bypass a SignalR-polluted cache entry left behind by
   * `ImportProgressPage`). Defaults to TanStack's standard staleness
   * heuristic when omitted.
   */
  refetchOnMount?: boolean | 'always'
}

/**
 * Polling query for `GET /api/imports/:importId`.
 *
 * Polling behaviour (PV3):
 *   - Default cadence is `DEFAULT_IMPORT_POLL_MS` (3 s). SignalR is the
 *     primary transport; the poll is a fallback.
 *   - When a SignalR `RecipeImportProgressChanged` event arrived within
 *     `SIGNALR_FRESH_WINDOW_MS`, we skip the next poll (return the
 *     poll-interval again instead of fetching now — TanStack Query
 *     re-evaluates the function after the delay, picking up the next
 *     decision point).
 *   - Terminal states (`done` / `error`) stop polling entirely.
 */
export function useImportStatus(
  importId: string | undefined,
  options?: UseImportStatusOptions,
) {
  const pollMs = options?.refetchInterval ?? DEFAULT_IMPORT_POLL_MS
  const enabled = (options?.enabled ?? true) && !!importId

  return useQuery<RecipeImportDto>({
    queryKey: importId
      ? importQueryKeys.status(importId)
      : ['imports', 'status', 'disabled'],
    queryFn: () => fetchImport(importId!),
    enabled,
    refetchOnMount: options?.refetchOnMount,
    refetchInterval: (query) => {
      const data = query.state.data
      if (!data) return pollMs
      if (data.status === 'done' || data.status === 'error') return false

      // SignalR freshness check — if an event landed inside the window,
      // postpone the next poll by doubling the interval. TanStack-Query
      // evaluates this callback after each settle, so returning a longer
      // delay defers the next GET cleanly. When the window expires the
      // next evaluation falls back to the normal `pollMs` cadence.
      if (importId) {
        const lastEventAt = readImportLiveEventAt(importId)
        if (lastEventAt != null) {
          const delta = Date.now() - lastEventAt
          if (delta < SIGNALR_FRESH_WINDOW_MS) return pollMs * 2
        }
      }
      return pollMs
    },
    // Keep polling even when the tab backgrounds — the user may come
    // back after 30 s and expect the progress bar to reflect reality.
    refetchIntervalInBackground: true,
  })
}

/**
 * COVER-0 — lazy fetch of an import's still-unpromoted cover
 * candidates. Used by the RecipeFormPage picker grid (pre-save) and
 * the RecipeDetailPage "Cover ändern" modal (post-save).
 *
 * The query returns `[]` on 410 Gone (sweep reaped the batch) so
 * callers render the "no picker UI" zero-state rather than an error
 * banner; every other error class propagates verbatim. Caller gates
 * the query via `enabled` so a recipe form without an importId
 * never fires the fetch.
 */
export function useImportCandidates(
  importId: string | undefined,
  options?: { enabled?: boolean },
) {
  const enabled = (options?.enabled ?? true) && !!importId
  return useQuery<ImportCandidate[]>({
    queryKey: importId
      ? importQueryKeys.candidates(importId)
      : ['imports', 'candidates', 'disabled'],
    queryFn: () => fetchImportCandidates(importId!),
    enabled,
    // The signedUrl TTL is short (~15 min) but the picker grid's
    // re-render frequency is low, so we skip proactive refetch here.
    // If a signed URL expires mid-session the <img> just fails to
    // load; the user can refresh the page. Not worth a background
    // poll loop for this low-traffic surface.
    staleTime: 5 * 60 * 1000,
  })
}

/**
 * Mutation wrapper around `POST /api/imports/{importId}/retry`.
 *
 * The endpoint returns the standard ImportStatusResponse shape with the
 * row already reset back to Queued / AttemptNumber 1 / no error. We
 * write the response into both
 *   - the per-id status cache (so an open ImportProgressPage flips
 *     visually without a poll round-trip), and
 *   - the mine-list caches (so the row's status chip on the
 *     ImportListPage flips immediately).
 * The mine-list update is patched in place rather than invalidated to
 * avoid a flash of "loading…" while the next poll refreshes.
 */
export function useRetryImport() {
  const queryClient = useQueryClient()
  return useMutation<RecipeImportDto, Error, string>({
    mutationFn: (importId) => retryImport(importId),
    onSuccess: (data) => {
      // Per-id cache write so the progress page picks up the reset.
      queryClient.setQueryData(importQueryKeys.status(data.id), data)
      // Patch every cached mine-list (different limits / queries) in
      // place so the ImportListPage row's chip flips immediately.
      queryClient.setQueriesData<ImportSummaryDto[]>(
        { queryKey: importQueryKeys.all },
        (current) => {
          if (!Array.isArray(current)) return current
          return current.map((row) =>
            row.id === data.id
              ? {
                  ...row,
                  status: data.status,
                  progress: data.progress,
                  phase: data.phase ?? row.phase,
                  progressLabel: data.progressLabel ?? null,
                  errorMessage: data.errorMessage,
                  completedAt: data.completedAt,
                }
              : row,
          )
        },
      )
    },
  })
}

/**
 * BUG-010 — caller-facing list of the user's most-recent imports.
 *
 * Polls at the default import cadence while any row is still in a
 * non-terminal state so the list reflects progress as jobs advance.
 * When every row is Done/Error we stop polling — the user explicitly
 * has to refresh (or navigate back into the page) to re-check.
 */
export function useMyImports(limit = 20) {
  return useQuery<ImportSummaryDto[]>({
    queryKey: importQueryKeys.mine(limit),
    queryFn: () => fetchMyImports(limit),
    refetchInterval: (query) => {
      const data = query.state.data
      if (!data || data.length === 0) return false
      const anyActive = data.some(
        (row) => row.status === 'queued' || row.status === 'running',
      )
      return anyActive ? DEFAULT_IMPORT_POLL_MS : false
    },
    refetchIntervalInBackground: false,
  })
}
