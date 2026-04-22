import { beforeEach, describe, expect, it } from 'vitest'
import {
  PAYLOAD_TTL_MS,
  purgeStalePayloads,
  readSharePayload,
  saveSharePayload,
} from './sharePayloadStore'

/**
 * SHARE-1 — IndexedDB stash for the POST-multipart share-sheet
 * payload.
 *
 * The service worker receives `POST /share-target`, parses the
 * FormData, and writes the file blobs here before redirecting to
 * `/share-target?payload-key=<timestamp>`. The client-side
 * `<ShareTargetPage />` reads them back and hands them off to the
 * photo-import staging grid.
 *
 * These tests run against `fake-indexeddb/auto` (see src/test/setup.ts)
 * so the SW and the client branch share the same abstraction.
 */
describe('sharePayloadStore', () => {
  beforeEach(async () => {
    // `fake-indexeddb/auto` resets between test files but not between
    // cases in the same file — explicit purge keeps cases isolated.
    // Use a now that sits far in the past so every stale record is
    // trimmed regardless of what the previous case wrote.
    await purgeStalePayloads(Number.MAX_SAFE_INTEGER)
  })

  it('round-trips a File list through save → read', async () => {
    const a = new File(['hello'], 'a.jpg', { type: 'image/jpeg' })
    const b = new File(['world'], 'b.png', { type: 'image/png' })
    const key = 123456
    await saveSharePayload(key, [a, b])
    const out = await readSharePayload(key)
    expect(out).not.toBeNull()
    expect(out!).toHaveLength(2)
    expect(out![0]!.name).toBe('a.jpg')
    expect(out![0]!.type).toBe('image/jpeg')
    expect(out![1]!.name).toBe('b.png')
  })

  it('returns null for an unknown key', async () => {
    expect(await readSharePayload(999)).toBeNull()
  })

  it('purgeStalePayloads removes entries older than PAYLOAD_TTL_MS', async () => {
    const now = 10_000_000
    // Write two records, one with a stale createdAt and one fresh, then
    // ask the purge to run as if the clock read `now`.
    const staleKey = 1
    const freshKey = 2
    const file = new File(['x'], 'x.jpg', { type: 'image/jpeg' })
    await saveSharePayload(staleKey, [file], now - PAYLOAD_TTL_MS - 1)
    await saveSharePayload(freshKey, [file], now - 1000)

    await purgeStalePayloads(now)

    expect(await readSharePayload(staleKey)).toBeNull()
    expect(await readSharePayload(freshKey)).not.toBeNull()
  })

  it('saveSharePayload purges its own stale neighbours on write', async () => {
    // Share-target hits are the only time we touch this store; piggy-
    // backing the purge on write keeps the SW handler's hot path tiny.
    const staleNow = 20_000_000 - PAYLOAD_TTL_MS - 500
    const freshNow = 20_000_000
    const file = new File(['x'], 'x.jpg', { type: 'image/jpeg' })
    await saveSharePayload(1, [file], staleNow)
    // The second write stamps `createdAt = freshNow` and purges
    // neighbours whose `createdAt < freshNow - TTL`.
    await saveSharePayload(2, [file], freshNow)
    expect(await readSharePayload(1)).toBeNull()
    expect(await readSharePayload(2)).not.toBeNull()
  })
})
