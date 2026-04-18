/**
 * Stub for the `virtual:pwa-register` virtual module used by tests.
 * Swapped in via a `resolve.alias` entry in `vitest.config.ts` so
 * imports of the virtual module resolve to this file in the test
 * environment. Individual tests override behaviour with `vi.mock()`.
 */
export function registerSW(): (reloadPage?: boolean) => Promise<void> {
  return () => Promise.resolve()
}
