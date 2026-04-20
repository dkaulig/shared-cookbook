import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister'
import type { AsyncStorage } from '@tanstack/react-query-persist-client'
import { del, get, set } from 'idb-keyval'

/**
 * OFF1 — TanStack Query cache persistence.
 *
 * We persist the query cache to IndexedDB so that the PWA renders the
 * last-known recipe list / meal plan / shopping list on reload, even
 * when the tablet has no WiFi. The Workbox runtime cache already stores
 * GET responses at the network layer; this complements it by skipping
 * the fetch altogether and letting TanStack hydrate straight from IDB.
 *
 * Design choices:
 * - IndexedDB via `idb-keyval` instead of localStorage — localStorage
 *   is ~5 MiB, synchronous, and blocks the main thread; IDB scales to
 *   recipe-photo-heavy workloads.
 * - `createAsyncStoragePersister` (not `experimental_createPersister`)
 *   — the async-storage API is the stable v5 surface and matches the
 *   architecture doc's naming (read-cache persistence, not per-query).
 * - Buster key = `VITE_APP_VERSION` (injected in `vite.config.ts`).
 *   Production builds derive it from `package.json` version; dev builds
 *   fall back to `'dev'` so hot-reloads don't trash the cache.
 */

/** Stable IDB key; exposed for test flushes + deletions. */
export const IDB_QUERY_KEY = 'fk-query-cache'

/**
 * Buster for `PersistQueryClientProvider` — when this changes between
 * builds the persister drops the restored client, so a deploy
 * invalidates stale cache shapes automatically (TanStack's own docs
 * recommend tying the buster to app version).
 */
export const CACHE_VERSION: string = import.meta.env.VITE_APP_VERSION ?? 'dev'

/** 7 days, in ms — architecture-doc default. */
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Thin adapter that wraps `idb-keyval` in the `AsyncStorage` interface
 * the persister expects. Values are serialized JSON strings.
 */
export const idbStorage: AsyncStorage<string> = {
  getItem: async (key) => (await get<string>(key)) ?? null,
  setItem: async (key, value) => {
    await set(key, value)
  },
  removeItem: async (key) => {
    await del(key)
  },
}

/**
 * Shared persister singleton. The `PersistQueryClientProvider` in
 * `main.tsx` consumes this directly; tests can re-import and call
 * `persister.removeClient()` to reset state between cases.
 */
export const persister = createAsyncStoragePersister({
  storage: idbStorage,
  key: IDB_QUERY_KEY,
})

/**
 * Keys whose queries we explicitly DO NOT persist. Resuming these from
 * IDB after a reload would be actively wrong:
 * - `chat`: hydrating a stale chat session looks like the model is
 *   replying to yesterday's conversation.
 * - `imports` / `importStatus`: the progress poll is live-only; a
 *   hydrated half-finished "50%" would block forever on a missing job.
 * - `stagedPhoto` / `stagedPhotos`: SeaweedFS upload handles have TTLs;
 *   hydrating them points the UI at dead blobs.
 */
const EPHEMERAL_KEY_PREFIXES: readonly string[] = [
  'chat',
  'imports',
  'importStatus',
  'stagedPhoto',
  'stagedPhotos',
]

/**
 * `shouldDehydrateQuery` predicate — gatekeeper between the live cache
 * and IDB. Exposed so tests can exercise the exact same function the
 * provider uses at runtime.
 */
export function shouldDehydrateQuery(query: {
  queryKey: readonly unknown[]
  state: { status: string }
}): boolean {
  const head = query.queryKey[0]
  if (typeof head === 'string' && EPHEMERAL_KEY_PREFIXES.includes(head)) {
    return false
  }
  // Persist only successful queries — mid-flight loading states or
  // errors shouldn't survive a reload.
  return query.state.status === 'success'
}
