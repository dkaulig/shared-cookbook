import { useMutation, useQuery } from '@tanstack/react-query'
import type {
  ImportEnqueueResponse,
  ImportUrlRequest,
  RecipeImportDto,
} from '@familien-kochbuch/shared'
import { enqueueUrlImport, fetchImport } from './importsApi'

/**
 * Query-key family for the imports feature. The progress page uses
 * `status(importId)` for its polling query; the URL form has no query,
 * only a mutation.
 */
export const importQueryKeys = {
  all: ['imports'] as const,
  status: (importId: string) => ['imports', 'status', importId] as const,
}

/** Default poll interval for `useImportStatus`. Matches the plan (2 s). */
export const DEFAULT_IMPORT_POLL_MS = 2000

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

interface UseImportStatusOptions {
  /** Override the default 2 s poll cadence (e.g. slower on mobile data). */
  refetchInterval?: number
  /** Disable the query entirely — useful in tests or when the id is empty. */
  enabled?: boolean
}

/**
 * Polling query for `GET /api/imports/:importId`.
 *
 * TanStack Query's `refetchInterval` accepts a function that can return
 * `false` to stop polling — we use that to freeze the query the moment
 * the backend reports a terminal state (`done` or `error`) so we don't
 * keep hammering the endpoint after the job settled.
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
    // `query.state.data` is the last-known import payload. Return the
    // poll interval while still queued/running; return `false` to stop
    // the polling loop once the backend reaches a terminal state. A
    // missing `data` (before the first response) defaults to the poll
    // interval so the initial fetch drives the UI.
    refetchInterval: (query) => {
      const data = query.state.data
      if (!data) return pollMs
      if (data.status === 'done' || data.status === 'error') return false
      return pollMs
    },
    // Keep polling even when the tab backgrounds — the user may come
    // back after 30 s and expect the progress bar to reflect reality.
    refetchIntervalInBackground: true,
  })
}
