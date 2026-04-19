import { useMutation, useQuery } from '@tanstack/react-query'
import type {
  ImportEnqueueResponse,
  ImportPhotosRequest,
  ImportUrlRequest,
  RecipeImportDto,
} from '@familien-kochbuch/shared'
import { enqueuePhotoImport, enqueueUrlImport, fetchImport } from './importsApi'
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
