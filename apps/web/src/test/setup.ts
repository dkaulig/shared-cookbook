import '@testing-library/jest-dom/vitest'
// OFF1 — polyfill IndexedDB for jsdom so the TanStack Query persister
// (idb-keyval backed) works in unit tests. `fake-indexeddb/auto`
// registers the global `indexedDB` before any test imports run.
import 'fake-indexeddb/auto'
import { cleanup } from '@testing-library/react'
import { afterAll, afterEach, beforeAll } from 'vitest'
import { server } from './msw/server.ts'

// MSW lifecycle
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => {
  server.resetHandlers()
  cleanup()
})
afterAll(() => server.close())
