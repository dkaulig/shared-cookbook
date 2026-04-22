/* eslint-disable */
/**
 * SHARE-1 — POST share-target handler, loaded into the generated
 * Workbox service worker via `workbox.importScripts` (configured in
 * `apps/web/vite.config.ts`).
 *
 * Flow:
 *   1. iOS / Android share-sheet POSTs `/share-target` with
 *      multipart/form-data: `files[]` + optional url/text/title.
 *   2. Browsers don't fall the POST through to the React app — the SW
 *      has to respond. We stash the file blobs in IndexedDB under a
 *      rotating `<timestamp>` key and 303-redirect to
 *      `/share-target?payload-key=<timestamp>`.
 *   3. <ShareTargetPage /> reads the blobs back, hands them to the
 *      photo-import staging grid, then deletes the record.
 *
 * This script is plain ES2020 JS on purpose: it loads via
 * `importScripts()` inside the Workbox-generated SW, so it can't use
 * ES module imports and must stay self-contained. The logic
 * deliberately mirrors `src/features/share/sharePayloadStore.ts` (same
 * DB name, store name, payload shape) so the client branch can read
 * what the SW wrote.
 *
 * Attacker-controlled inputs (file blobs + url/text/title) are NEVER
 * rendered as HTML or executed as JS here. Blobs go straight into IDB
 * and back out to the photo-upload pipeline; the URL fallback funnels
 * into the existing extractSharedUrl gate.
 */

;(function () {
  'use strict'

  // Dedicated DB — matches sharePayloadStore.ts. Keep this file's
  // constants in sync with the TS module or the client branch will
  // read from an empty store.
  const DB_NAME = 'fk-share-target'
  const STORE_NAME = 'payloads'
  // 5 minutes. Matches PAYLOAD_TTL_MS in sharePayloadStore.ts.
  const PAYLOAD_TTL_MS = 5 * 60 * 1000
  const MAX_FILE_BYTES = 10 * 1024 * 1024
  const MAX_FILES = 5
  const ACCEPTED_MIME_TYPES = [
    'image/jpeg',
    'image/png',
    'image/heic',
    'image/webp',
  ]

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE_NAME)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }

  function tx(db, mode) {
    return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME)
  }

  function putPayload(key, payload) {
    return openDb().then((db) => {
      return new Promise((resolve, reject) => {
        const req = tx(db, 'readwrite').put(payload, key)
        req.onsuccess = () => {
          db.close()
          resolve()
        }
        req.onerror = () => {
          db.close()
          reject(req.error)
        }
      })
    })
  }

  function purge(now) {
    return openDb().then((db) => {
      return new Promise((resolve, reject) => {
        const store = tx(db, 'readwrite')
        const req = store.openCursor()
        req.onsuccess = () => {
          const cursor = req.result
          if (!cursor) {
            db.close()
            return resolve()
          }
          const v = cursor.value
          if (v && now - v.createdAt > PAYLOAD_TTL_MS) {
            cursor.delete()
          }
          cursor.continue()
        }
        req.onerror = () => {
          db.close()
          reject(req.error)
        }
      })
    })
  }

  function filterFiles(formData) {
    const out = []
    const raw = formData.getAll('files')
    for (let i = 0; i < raw.length; i++) {
      const entry = raw[i]
      // Share sheets can silently attach a stringified `undefined` or
      // empty text part if the user shared nothing — those aren't File
      // instances and must be ignored.
      if (!(entry instanceof File)) continue
      if (ACCEPTED_MIME_TYPES.indexOf(entry.type) === -1) continue
      if (entry.size > MAX_FILE_BYTES) continue
      out.push({ name: entry.name, type: entry.type, blob: entry })
      if (out.length >= MAX_FILES) break
    }
    return out
  }

  async function handleShareTarget(request) {
    const now = Date.now()
    let formData
    try {
      formData = await request.formData()
    } catch (_err) {
      // Malformed multipart — bounce to share-target with no payload so
      // the React component renders the German empty-state.
      return redirect('/share-target')
    }

    const files = filterFiles(formData)

    // If there are no usable files but a URL-ish payload came along,
    // forward the URL/text/title query params so the existing SHARE-0
    // path keeps working when iOS sends a URL via POST. Same allowlist
    // as the GET branch (extractSharedUrl).
    if (files.length === 0) {
      const params = new URLSearchParams()
      const keys = ['url', 'text', 'title']
      for (let i = 0; i < keys.length; i++) {
        const v = formData.get(keys[i])
        if (typeof v === 'string' && v.length > 0 && v.length <= 2000) {
          params.set(keys[i], v)
        }
      }
      const q = params.toString()
      return redirect(
        q.length > 0 ? '/share-target?' + q : '/share-target',
      )
    }

    try {
      await putPayload(now, { createdAt: now, files: files })
      await purge(now)
    } catch (_err) {
      // IDB unavailable (private mode / quota) — bounce to share-target
      // with no payload so the React empty-state renders instead of a
      // hard failure. The user can still manually import.
      return redirect('/share-target')
    }

    return redirect('/share-target?payload-key=' + now)
  }

  /**
   * Tiny helper that builds a same-origin 303 redirect response
   * without relying on `Response.redirect` — that static requires an
   * absolute URL, which fails in Node's undici during unit tests.
   * Browsers honour a bare `Location: /path` header; this shape
   * matches what service-worker runtimes accept in practice.
   */
  function redirect(location) {
    return new Response(null, {
      status: 303,
      headers: { Location: location },
    })
  }

  self.addEventListener('fetch', (event) => {
    const req = event.request
    if (req.method !== 'POST') return
    // Security: only treat a POST as a share-target invocation when
    // it's a top-level navigation. A random cross-origin fetch (e.g.
    // `fetch('/share-target', { method: 'POST', mode: 'no-cors' })`
    // from a hostile page) has mode === 'no-cors' or 'cors' — both
    // fall through here and hit the network instead of populating
    // our IDB. Genuine share-sheet invocations are navigations.
    if (req.mode !== 'navigate') return
    const url = new URL(req.url)
    if (url.pathname !== '/share-target') return
    event.respondWith(handleShareTarget(req))
  })

  // Exported for the vitest suite to reach in (via a sandboxed eval).
  // Overwriting `self.__fkShareTarget` is harmless at runtime — no
  // other code ever reads it.
  self.__fkShareTarget = {
    handleShareTarget: handleShareTarget,
    filterFiles: filterFiles,
    DB_NAME: DB_NAME,
    STORE_NAME: STORE_NAME,
  }
})()
