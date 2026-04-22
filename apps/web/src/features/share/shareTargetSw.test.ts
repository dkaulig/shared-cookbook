import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInThisContext } from 'node:vm'
import { beforeEach, describe, expect, it } from 'vitest'

/**
 * SHARE-1 — service worker fetch handler (public/share-target-sw.js).
 *
 * The SW file isn't a module — it loads via `importScripts` in the
 * generated Workbox SW and registers a top-level
 * `self.addEventListener('fetch', …)`. For testing we evaluate the
 * same JS inside a fabricated `self` so we can hit the exported
 * `__fkShareTarget` internals (the SW file writes this for test
 * purposes only).
 *
 * What's covered:
 *   - POST /share-target with images writes a record keyed by
 *     `Date.now()` + 303-redirects to `?payload-key=<same timestamp>`.
 *   - POST /share-target with no usable files forwards the URL
 *     params so the SHARE-0 GET branch keeps working after the
 *     manifest switched to POST.
 *   - The fetch listener is a no-op for non-POST + non-
 *     /share-target requests (must not eat the rest of the origin).
 *   - filterFiles applies the same MIME/size/count gates as the TS
 *     helper; this is a second layer because the SW and the client
 *     code can't import a shared ESM helper.
 */

const swSource = readFileSync(
  resolve(__dirname, '../../../public/share-target-sw.js'),
  'utf8',
)

interface SwExports {
  handleShareTarget: (request: Request) => Promise<Response>
  filterFiles: (fd: FormData) => Array<{ name: string; type: string; blob: Blob }>
  DB_NAME: string
  STORE_NAME: string
}

interface SwSandbox {
  exports: SwExports
  listener: (event: { request: Request; respondWith: (r: Promise<Response>) => void }) => void
}

function loadSw(): SwSandbox {
  // Capture addEventListener so the test can invoke the fetch handler
  // without a real ServiceWorker runtime. We run the SW source inside
  // this jsdom context (not an isolated vm.Context) so it shares the
  // test's `Request`/`Response`/`FormData`/`indexedDB` globals.
  let capturedListener:
    | ((event: {
        request: Request
        respondWith: (r: Promise<Response>) => void
      }) => void)
    | null = null
  const fakeSelf: {
    addEventListener: (
      type: string,
      cb: (event: {
        request: Request
        respondWith: (r: Promise<Response>) => void
      }) => void,
    ) => void
    __fkShareTarget?: SwExports
  } = {
    addEventListener: (type, cb) => {
      if (type === 'fetch') capturedListener = cb
    },
  }
  // Wrap the source so it sees our `self` via a parameterised IIFE,
  // then hand the wrapper to `vm.runInThisContext`. No `new Function`
  // (security-hook-safe) and no isolated context (we want the real
  // jsdom globals like indexedDB / FormData).
  const wrapped = `(function(self){${swSource}\n})`
  const factory = runInThisContext(wrapped) as (self: typeof fakeSelf) => void
  factory(fakeSelf)
  if (!fakeSelf.__fkShareTarget) {
    throw new Error('SW did not export __fkShareTarget')
  }
  if (!capturedListener) throw new Error('SW did not register a fetch listener')
  return { exports: fakeSelf.__fkShareTarget, listener: capturedListener }
}

async function resetIdb(dbName: string): Promise<void> {
  await new Promise<void>((resolveP, reject) => {
    const req = indexedDB.deleteDatabase(dbName)
    req.onsuccess = () => resolveP()
    req.onerror = () => reject(req.error)
    req.onblocked = () => resolveP()
  })
}

/**
 * The SW handler only cares about `request.method`, `request.url`, and
 * `await request.formData()`. Node's undici FormData parser chokes on
 * the global jsdom `File` constructor, so instead of round-tripping
 * through `new Request(body)` we hand-build a tiny request shape with
 * a pre-resolved FormData — same surface the SW touches.
 */
function fakeRequest(
  url: string,
  method: string,
  fd?: FormData,
  mode: RequestMode = 'navigate',
): Request {
  return {
    method,
    url,
    mode,
    formData: async () => fd ?? new FormData(),
  } as unknown as Request
}

describe('share-target-sw.js', () => {
  let sw: SwSandbox
  beforeEach(async () => {
    sw = loadSw()
    await resetIdb(sw.exports.DB_NAME)
  })

  it('filterFiles keeps JPEG + PNG + HEIC + WebP and drops non-image / oversize', () => {
    const fd = new FormData()
    fd.append(
      'files',
      new File([new Uint8Array(10)], 'a.jpg', { type: 'image/jpeg' }),
    )
    fd.append(
      'files',
      new File([new Uint8Array(10)], 'b.png', { type: 'image/png' }),
    )
    fd.append(
      'files',
      new File([new Uint8Array(10)], 'c.heic', { type: 'image/heic' }),
    )
    fd.append(
      'files',
      new File([new Uint8Array(10)], 'd.webp', { type: 'image/webp' }),
    )
    fd.append(
      'files',
      new File([new Uint8Array(10)], 'bad.pdf', { type: 'application/pdf' }),
    )
    fd.append(
      'files',
      new File([new Uint8Array(11 * 1024 * 1024)], 'huge.jpg', {
        type: 'image/jpeg',
      }),
    )
    const out = sw.exports.filterFiles(fd)
    expect(out.map((f) => f.type)).toEqual([
      'image/jpeg',
      'image/png',
      'image/heic',
      'image/webp',
    ])
  })

  it('filterFiles caps the list at 5 files', () => {
    const fd = new FormData()
    for (let i = 0; i < 8; i++) {
      fd.append(
        'files',
        new File([new Uint8Array(10)], `p${i}.jpg`, { type: 'image/jpeg' }),
      )
    }
    expect(sw.exports.filterFiles(fd)).toHaveLength(5)
  })

  it('handleShareTarget writes the file blobs to IndexedDB and 303-redirects with ?payload-key=<ts>', async () => {
    const fd = new FormData()
    fd.append(
      'files',
      new File([new Uint8Array(10)], 'ok.jpg', { type: 'image/jpeg' }),
    )
    const req = fakeRequest('https://app.example/share-target', 'POST', fd)
    const res = await sw.exports.handleShareTarget(req)
    expect(res.status).toBe(303)
    const location = res.headers.get('location') ?? ''
    expect(location).toMatch(/^\/share-target\?payload-key=\d+$/)
    const payloadKey = Number(location.split('=')[1])
    expect(Number.isFinite(payloadKey)).toBe(true)

    // The stashed record is readable with a raw IDB access.
    const db = await new Promise<IDBDatabase>((resolveP, reject) => {
      const r = indexedDB.open(sw.exports.DB_NAME, 1)
      r.onsuccess = () => resolveP(r.result)
      r.onerror = () => reject(r.error)
    })
    try {
      const stored = await new Promise<{
        createdAt: number
        files: Array<{ name: string; type: string; blob: Blob }>
      }>((resolveP, reject) => {
        const r = db
          .transaction(sw.exports.STORE_NAME, 'readonly')
          .objectStore(sw.exports.STORE_NAME)
          .get(payloadKey)
        r.onsuccess = () => resolveP(r.result as never)
        r.onerror = () => reject(r.error)
      })
      expect(stored.files).toHaveLength(1)
      expect(stored.files[0]!.name).toBe('ok.jpg')
      expect(stored.files[0]!.type).toBe('image/jpeg')
    } finally {
      db.close()
    }
  })

  it('handleShareTarget with a URL payload but no files forwards to /share-target?url=… (SHARE-0 behaviour preserved on POST)', async () => {
    const fd = new FormData()
    fd.append('url', 'https://fb.com/x')
    fd.append('text', 'see this reel')
    const req = fakeRequest('https://app.example/share-target', 'POST', fd)
    const res = await sw.exports.handleShareTarget(req)
    expect(res.status).toBe(303)
    const location = res.headers.get('location') ?? ''
    expect(location).toMatch(
      /^\/share-target\?url=https%3A%2F%2Ffb\.com%2Fx&text=see\+this\+reel$/,
    )
  })

  it('handleShareTarget with neither files nor URL payload redirects to /share-target without a query string', async () => {
    const fd = new FormData()
    const req = fakeRequest('https://app.example/share-target', 'POST', fd)
    const res = await sw.exports.handleShareTarget(req)
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/share-target')
  })

  it('the fetch listener passes through non-POST requests (never calls respondWith)', () => {
    let respondCount = 0
    const event = {
      request: fakeRequest('https://app.example/api/recipes', 'GET'),
      respondWith: () => {
        respondCount++
      },
    }
    sw.listener(event)
    expect(respondCount).toBe(0)
  })

  it('the fetch listener passes through POSTs to paths other than /share-target', () => {
    let respondCount = 0
    const event = {
      request: fakeRequest('https://app.example/api/recipes', 'POST'),
      respondWith: () => {
        respondCount++
      },
    }
    sw.listener(event)
    expect(respondCount).toBe(0)
  })

  it('the fetch listener intercepts POST /share-target', () => {
    let respondCount = 0
    const event = {
      request: fakeRequest(
        'https://app.example/share-target',
        'POST',
        new FormData(),
      ),
      respondWith: () => {
        respondCount++
      },
    }
    sw.listener(event)
    expect(respondCount).toBe(1)
  })

  it('the fetch listener does NOT intercept a cross-origin POST with mode=cors (CSRF-style storage abuse blocked)', () => {
    // A hostile page doing `fetch('/share-target', { method: 'POST',
    // body: fd })` sends mode === 'cors' (or 'no-cors' with
    // `mode: 'no-cors'`). Neither equals 'navigate', so the SW stays
    // out of the way and the request hits the network (where it 404s
    // because we have no server handler). Prevents attacker from
    // filling the user's IDB quota through a drive-by POST.
    let respondCount = 0
    const event = {
      request: fakeRequest(
        'https://app.example/share-target',
        'POST',
        new FormData(),
        'cors',
      ),
      respondWith: () => {
        respondCount++
      },
    }
    sw.listener(event)
    expect(respondCount).toBe(0)
  })
})
