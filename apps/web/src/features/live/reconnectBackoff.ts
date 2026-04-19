/**
 * P3-8 reconnect backoff for <see cref="useLiveSync"/>. Matches the
 * plan's schedule: 500ms → 1s → 2s → 5s → 10s → 30s cap.
 *
 * Exported as a plain function so tests can hit it directly without
 * touching SignalR at all — the frontend test-plan calls for a
 * reconnect-backoff test that asserts the first retry is 500ms and
 * each subsequent retry is >= the previous one.
 */
const BACKOFF_SCHEDULE_MS = [500, 1000, 2000, 5000, 10000, 30000] as const

export const RECONNECT_BACKOFF_SCHEDULE_MS: readonly number[] = BACKOFF_SCHEDULE_MS

/**
 * Returns the delay (milliseconds) to wait before the Nth retry
 * attempt. Past the schedule's last entry the cap (30s) is returned —
 * SignalR never stops trying until the consumer stops the connection.
 */
export function nextReconnectDelayMs(retryCount: number): number {
  const first = BACKOFF_SCHEDULE_MS[0]
  const last = BACKOFF_SCHEDULE_MS[BACKOFF_SCHEDULE_MS.length - 1]!
  if (retryCount < 0) return first
  if (retryCount < BACKOFF_SCHEDULE_MS.length)
    return BACKOFF_SCHEDULE_MS[retryCount]!
  return last
}
