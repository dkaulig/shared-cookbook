/**
 * Tiny cross-module shared store for "when did we last see a SignalR
 * `RecipeImportProgressChanged` event for import X?".
 *
 * Lives outside the React tree so the poll heuristic in `useImportStatus`
 * can ask it without going through context/props/refs. Keeping it a
 * module-level `Map` also means tests can reset it between cases via
 * {@link clearImportLiveEvents} without tearing down the QueryClient.
 */

const timestamps: Map<string, number> = new Map()

/** Record that a SignalR event just landed for `importId`. */
export function recordImportLiveEvent(importId: string, nowMs?: number): void {
  timestamps.set(importId, nowMs ?? Date.now())
}

/**
 * Returns the millisecond timestamp of the most recent SignalR event
 * for `importId`, or `null` if none has been observed this session.
 */
export function readImportLiveEventAt(importId: string): number | null {
  const value = timestamps.get(importId)
  return value ?? null
}

/** Test-only reset. Called by beforeEach in test suites. */
export function clearImportLiveEvents(): void {
  timestamps.clear()
}
