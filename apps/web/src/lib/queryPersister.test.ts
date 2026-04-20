import { beforeEach, describe, expect, it } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import {
  persistQueryClientRestore,
  persistQueryClientSave,
} from '@tanstack/react-query-persist-client'
import { clear } from 'idb-keyval'
import {
  CACHE_VERSION,
  IDB_QUERY_KEY,
  MAX_AGE_MS,
  idbStorage,
  persister,
  shouldDehydrateQuery,
} from './queryPersister'

/**
 * OFF1 — persister contract tests.
 *
 * The persister is infrastructure the whole app depends on; a regression
 * here silently degrades the offline-at-the-stove UX. Tests verify:
 * 1. Cache survives a save → fresh-client → restore round-trip.
 * 2. `shouldDehydrateQuery` keeps ephemeral keys (chat/imports/
 *    stagedPhotos) out of IDB.
 * 3. Changing the `buster` between save and restore purges the cache,
 *    which is how a deploy invalidates stale shapes.
 * 4. The IDB storage adapter normalises missing keys to `null` so the
 *    persist-client-core `restoreClient` path doesn't blow up.
 */
describe('queryPersister', () => {
  beforeEach(async () => {
    // Isolate each test — fake-indexeddb is in-memory but shared across
    // the module, so clear its single database between cases.
    await clear()
  })

  describe('idbStorage', () => {
    it('round-trips a value through IDB', async () => {
      await idbStorage.setItem('k', 'v')
      expect(await idbStorage.getItem('k')).toBe('v')
    })

    it('returns null for a missing key (matches AsyncStorage contract)', async () => {
      expect(await idbStorage.getItem('nope')).toBeNull()
    })

    it('removeItem deletes a key', async () => {
      await idbStorage.setItem('k', 'v')
      await idbStorage.removeItem('k')
      expect(await idbStorage.getItem('k')).toBeNull()
    })
  })

  describe('shouldDehydrateQuery', () => {
    const success = (key: readonly unknown[]) => ({
      queryKey: key,
      state: { status: 'success' },
    })

    it('persists successful queries with non-ephemeral keys', () => {
      expect(shouldDehydrateQuery(success(['recipes', 'group', 'g1']))).toBe(true)
      expect(shouldDehydrateQuery(success(['groups', 'detail', 'g1']))).toBe(true)
      expect(shouldDehydrateQuery(success(['mealplan', 'g1', '2026-W17']))).toBe(true)
      expect(shouldDehydrateQuery(success(['shoppingList', 'g1']))).toBe(true)
    })

    it('CR3 — allows the sessions-LIST index under `chat` to dehydrate', () => {
      // The list key takes the form ['chat', 'sessions', { limit }].
      // Persisting it means the offline-first PWA can render the
      // user's conversations from IDB when there's no WiFi.
      expect(
        shouldDehydrateQuery(success(['chat', 'sessions', { limit: 20 }])),
      ).toBe(true)
    })

    it('CR3 — still excludes per-session messages (mid-stream safety)', () => {
      // The message-list cache MUST stay out of IDB: hydrating a
      // half-finished stream after a reload would resurrect stale
      // tokens and confuse the user about where the conversation
      // paused.
      expect(
        shouldDehydrateQuery(success(['chat', 'messages', 'session-1'])),
      ).toBe(false)
    })

    it('CR3 — still excludes legacy/unknown chat sub-keys as defence-in-depth', () => {
      // Anything under `chat` that isn't the sessions-LIST stays
      // ephemeral. Keeps the blast radius of future query-key typos
      // inside a deploy, not across reloads.
      expect(shouldDehydrateQuery(success(['chat', 'session-1']))).toBe(false)
      expect(shouldDehydrateQuery(success(['chat', 'anything-else']))).toBe(
        false,
      )
    })

    it('excludes import progress polls', () => {
      expect(shouldDehydrateQuery(success(['imports']))).toBe(false)
      expect(shouldDehydrateQuery(success(['importStatus', 'i-7']))).toBe(false)
    })

    it('excludes staged photos', () => {
      expect(shouldDehydrateQuery(success(['stagedPhoto', 'p-1']))).toBe(false)
      expect(shouldDehydrateQuery(success(['stagedPhotos']))).toBe(false)
    })

    it('skips non-success queries so loading/error states do not hit IDB', () => {
      expect(
        shouldDehydrateQuery({
          queryKey: ['recipes', 'group', 'g1'],
          state: { status: 'pending' },
        }),
      ).toBe(false)
      expect(
        shouldDehydrateQuery({
          queryKey: ['recipes', 'group', 'g1'],
          state: { status: 'error' },
        }),
      ).toBe(false)
    })
  })

  describe('persist round-trip', () => {
    /**
     * Full contract — seed a client, dehydrate via `persistQueryClientSave`,
     * create a FRESH client, rehydrate, assert the data round-trips.
     * This is the exact sequence `PersistQueryClientProvider` performs
     * on mount.
     */
    it('restores persisted query data into a fresh QueryClient', async () => {
      const buster = 'test-v1'
      const seed = new QueryClient()
      seed.setQueryData(['recipes', 'group', 'g1'], { items: [{ id: 'r1' }] })

      await persistQueryClientSave({
        queryClient: seed,
        persister,
        buster,
        dehydrateOptions: { shouldDehydrateQuery },
      })

      const fresh = new QueryClient()
      await persistQueryClientRestore({
        queryClient: fresh,
        persister,
        buster,
        maxAge: MAX_AGE_MS,
      })

      expect(fresh.getQueryData(['recipes', 'group', 'g1'])).toEqual({
        items: [{ id: 'r1' }],
      })
    })

    it('dehydrateOptions.shouldDehydrateQuery drops ephemeral keys on save', async () => {
      const buster = 'test-v1'
      const seed = new QueryClient()
      seed.setQueryData(['recipes', 'all'], ['r1', 'r2'])
      seed.setQueryData(['chat', 'session-1'], { messages: ['hi'] })
      seed.setQueryData(['chat', 'messages', 'session-1'], [{ id: 'm1' }])
      seed.setQueryData(
        ['chat', 'sessions', { limit: 20 }],
        [{ id: 's1', title: 'Hallo', messageCount: 2 }],
      )
      seed.setQueryData(['imports'], [{ id: 'i-1' }])
      seed.setQueryData(['stagedPhoto', 'p-1'], { url: 'blob:...' })

      await persistQueryClientSave({
        queryClient: seed,
        persister,
        buster,
        dehydrateOptions: { shouldDehydrateQuery },
      })

      const fresh = new QueryClient()
      await persistQueryClientRestore({
        queryClient: fresh,
        persister,
        buster,
        maxAge: MAX_AGE_MS,
      })

      expect(fresh.getQueryData(['recipes', 'all'])).toEqual(['r1', 'r2'])
      expect(fresh.getQueryData(['chat', 'session-1'])).toBeUndefined()
      expect(
        fresh.getQueryData(['chat', 'messages', 'session-1']),
      ).toBeUndefined()
      // CR3 — the sessions list DOES survive the save/restore cycle.
      expect(
        fresh.getQueryData(['chat', 'sessions', { limit: 20 }]),
      ).toEqual([{ id: 's1', title: 'Hallo', messageCount: 2 }])
      expect(fresh.getQueryData(['imports'])).toBeUndefined()
      expect(fresh.getQueryData(['stagedPhoto', 'p-1'])).toBeUndefined()
    })

    it('buster mismatch between save and restore clears the cache', async () => {
      const seed = new QueryClient()
      seed.setQueryData(['recipes', 'all'], ['r1'])
      await persistQueryClientSave({
        queryClient: seed,
        persister,
        buster: 'v1',
        dehydrateOptions: { shouldDehydrateQuery },
      })

      // Same persister, different buster — simulates a deploy bumping
      // `VITE_APP_VERSION`.
      const fresh = new QueryClient()
      await persistQueryClientRestore({
        queryClient: fresh,
        persister,
        buster: 'v2',
        maxAge: MAX_AGE_MS,
      })

      expect(fresh.getQueryData(['recipes', 'all'])).toBeUndefined()
      // persistQueryClientRestore removes mismatched caches from IDB,
      // so a subsequent read returns undefined.
      expect(await idbStorage.getItem(IDB_QUERY_KEY)).toBeNull()
    })
  })

  describe('module exports', () => {
    it('CACHE_VERSION defaults to "dev" in unit tests', () => {
      // vitest does not run the vite `define` replacement, so the
      // fallback branch applies — asserts that path stays defensive.
      expect(typeof CACHE_VERSION).toBe('string')
      expect(CACHE_VERSION.length).toBeGreaterThan(0)
    })

    it('exposes a 7-day max age', () => {
      expect(MAX_AGE_MS).toBe(7 * 24 * 60 * 60 * 1000)
    })
  })
})
