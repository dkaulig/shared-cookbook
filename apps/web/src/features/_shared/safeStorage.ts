/**
 * Tiny defensive wrappers around `window.sessionStorage`. Private-mode
 * Safari + very restrictive settings can throw on access (not only on
 * write — even reading `window.sessionStorage` itself can raise), so
 * every call path has to be guarded. Consolidated here to avoid the
 * same three-line try/catch being inlined across features.
 *
 * All helpers are no-op on the server (`typeof window === 'undefined'`)
 * and silently swallow storage errors — the feature UX always has a
 * "no memo" / "no preference" fallback, losing persistence is never
 * worth crashing the page for.
 */

function storageOrNull(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

export function safeGetItem(key: string): string | null {
  const s = storageOrNull()
  if (!s) return null
  try {
    return s.getItem(key)
  } catch {
    return null
  }
}

export function safeSetItem(key: string, value: string): void {
  const s = storageOrNull()
  if (!s) return
  try {
    s.setItem(key, value)
  } catch {
    /* quota exceeded or storage disabled — silent no-op. */
  }
}

export function safeRemoveItem(key: string): void {
  const s = storageOrNull()
  if (!s) return
  try {
    s.removeItem(key)
  } catch {
    /* ignore */
  }
}
