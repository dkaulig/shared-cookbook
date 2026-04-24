import '@testing-library/jest-dom/vitest'
// OFF1 — polyfill IndexedDB for jsdom so the TanStack Query persister
// (idb-keyval backed) works in unit tests. `fake-indexeddb/auto`
// registers the global `indexedDB` before any test imports run.
import 'fake-indexeddb/auto'
import { cleanup } from '@testing-library/react'
import { afterAll, afterEach, beforeAll } from 'vitest'
import { server } from './msw/server.ts'

// REL-3 — jsdom in this vitest build ships an incomplete localStorage
// (no `setItem` / `getItem` / `clear` on the prototype — the CLI warn
// `--localstorage-file was provided without a valid path` explains
// why). i18next-browser-languagedetector relies on those, as does the
// i18n foundation test. Install a small in-memory Storage polyfill so
// every spec sees a real Web-Storage API without changing global
// vitest config.
function installStoragePolyfill(key: 'localStorage' | 'sessionStorage') {
  const ls = window[key] as unknown as { setItem?: unknown }
  if (ls && typeof ls.setItem === 'function') return
  const store = new Map<string, string>()
  const polyfill: Storage = {
    get length() {
      return store.size
    },
    key(i) {
      return Array.from(store.keys())[i] ?? null
    },
    getItem(k) {
      return store.has(k) ? store.get(k)! : null
    },
    setItem(k, v) {
      store.set(k, String(v))
    },
    removeItem(k) {
      store.delete(k)
    },
    clear() {
      store.clear()
    },
  }
  Object.defineProperty(window, key, {
    configurable: true,
    enumerable: true,
    value: polyfill,
  })
}
installStoragePolyfill('localStorage')
installStoragePolyfill('sessionStorage')

// MSW lifecycle
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => {
  server.resetHandlers()
  cleanup()
})
afterAll(() => server.close())
