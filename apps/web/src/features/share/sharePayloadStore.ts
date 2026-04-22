/**
 * SHARE-1 — IndexedDB stash for Web Share Target POST payloads.
 *
 * The service worker can't hand file blobs straight to the client page
 * because the HTTP redirect crosses a navigation boundary and drops
 * any non-URL state. We stash the blobs in IndexedDB under a rotating
 * `<timestamp>` key and respond with `Location: /share-target?payload-
 * key=<timestamp>`. The client-side `<ShareTargetPage />` reads them
 * back, then deletes the record.
 *
 * Why `idb-keyval` with a dedicated database name instead of the
 * default `keyval-store`: the TanStack Query persister uses the same
 * library with its own store; keeping the share payload in a separate
 * database isolates the schemas and lets us wipe the share store
 * independently if we ever need to.
 *
 * Stale-purge: every write calls `purgeStalePayloads(now)` so the
 * store never grows beyond what a single in-flight share would need.
 * The TTL matches the design doc's "5 min" window — long enough to
 * survive a slow login round-trip but short enough that a user who
 * abandoned the share doesn't leave blobs on disk.
 */
import { createStore, del, entries, get, set } from 'idb-keyval'

/** 5 minutes in ms. A share in flight rarely takes more. */
export const PAYLOAD_TTL_MS = 5 * 60 * 1000

/**
 * Dedicated IDB database so the share-target payloads never collide
 * with the TanStack Query cache (`fk-query-cache`) or with any future
 * `idb-keyval`-backed store.
 */
const STORE = createStore('fk-share-target', 'payloads')

/**
 * Serialised file shape. Structured-clone preserves Blob bytes + MIME
 * type across IDB round-trips, but some runtimes (and our test
 * environment's fake-indexeddb) strip the `name` off File objects. We
 * explicitly keep the `name` next to the Blob and rebuild a real File
 * on read, so downstream consumers (the photo-import staging grid)
 * see the original filename.
 */
interface StoredFile {
  name: string
  type: string
  blob: Blob
}

interface SharePayload {
  createdAt: number
  files: StoredFile[]
}

function toStored(file: File): StoredFile {
  return { name: file.name, type: file.type, blob: file }
}

function fromStored(stored: StoredFile): File {
  return new File([stored.blob], stored.name, { type: stored.type })
}

export async function saveSharePayload(
  key: number,
  files: File[],
  now: number = Date.now(),
): Promise<void> {
  const payload: SharePayload = {
    createdAt: now,
    files: files.map(toStored),
  }
  await set(key, payload, STORE)
  // Piggy-back the purge on every write — keeps the SW handler's hot
  // path short (one trip through IDB) and means the store self-cleans
  // even if the user never opens the app between shares.
  await purgeStalePayloads(now)
}

export async function readSharePayload(key: number): Promise<File[] | null> {
  const payload = await get<SharePayload>(key, STORE)
  if (!payload) return null
  return payload.files.map(fromStored)
}

export async function deleteSharePayload(key: number): Promise<void> {
  await del(key, STORE)
}

export async function purgeStalePayloads(now: number): Promise<void> {
  const all = (await entries(STORE)) as Array<[IDBValidKey, SharePayload]>
  for (const [k, v] of all) {
    if (now - v.createdAt > PAYLOAD_TTL_MS) {
      await del(k, STORE)
    }
  }
}
