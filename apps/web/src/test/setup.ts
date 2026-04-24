import '@testing-library/jest-dom/vitest'
// OFF1 — polyfill IndexedDB for jsdom so the TanStack Query persister
// (idb-keyval backed) works in unit tests. `fake-indexeddb/auto`
// registers the global `indexedDB` before any test imports run.
import 'fake-indexeddb/auto'
import { cleanup } from '@testing-library/react'
import { afterAll, afterEach, beforeAll } from 'vitest'
import i18n, { createI18n } from '../i18n'
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

// REL-3e — boot the i18n singleton once for the whole vitest run so
// any feature-level test that renders components with `useTranslation`
// or calls `classifyMutationError` sees the resources loaded without
// a local `beforeAll(createI18n())` workaround. The default singleton
// is idempotent: `createI18n()` without `initialLng` mutates the
// shared instance and is safe to call before other module imports
// that might themselves import `@/i18n`.
//
// Pinned to `de` so tests that assert German `errors.json` /
// `translation.json` copy don't depend on the navigator.language of
// the test environment.
//
// Using top-level-await so the promise is resolved before vitest
// starts collecting test files — i18next's `init()` is synchronous in
// practice (resources are passed inline; there's no async backend)
// but awaiting here is the documented contract.
await createI18n()
await i18n.changeLanguage('de')
