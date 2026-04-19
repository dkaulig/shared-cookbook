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
 * Max retry attempts when the server has rejected our JWT (401). After
 * this many 401s in a row the backoff surrenders — the user has to
 * log in again. Without this the client would retry forever with a
 * stale token, producing one negotiate-401 per 30 s indefinitely.
 */
export const AUTH_FAILURE_MAX_RETRIES = 3

/**
 * Overall wall-clock cap before the backoff gives up regardless of
 * reason. SignalR's default is "retry forever"; that's wrong for a
 * battery-backed tab left open over night. After this many ms of
 * cumulative elapsed time the client stops and lets the user refresh
 * manually.
 */
export const MAX_TOTAL_RECONNECT_MS = 10 * 60 * 1000

/**
 * Returns the delay (milliseconds) to wait before the Nth retry
 * attempt. Past the schedule's last entry the cap (30s) is returned.
 * See <see cref="buildLiveSyncRetryPolicy"/> for the policy that
 * wraps this with auth-surrender + total-time caps.
 */
export function nextReconnectDelayMs(retryCount: number): number {
  const first = BACKOFF_SCHEDULE_MS[0]
  const last = BACKOFF_SCHEDULE_MS[BACKOFF_SCHEDULE_MS.length - 1]!
  if (retryCount < 0) return first
  if (retryCount < BACKOFF_SCHEDULE_MS.length)
    return BACKOFF_SCHEDULE_MS[retryCount]!
  return last
}

/**
 * Shape compatible with SignalR's <c>RetryContext</c> without importing
 * the SignalR types — keeps this file unit-testable without pulling
 * the WebSocket stack into the test worker.
 */
export interface ReconnectRetryContext {
  previousRetryCount: number
  elapsedMilliseconds: number
  retryReason?: { message?: string } | Error | unknown
}

/**
 * Extracts an error message from the arbitrary <c>retryReason</c>
 * shape SignalR hands us (usually an Error, occasionally a plain
 * object with a <c>message</c>, very rarely a bare string).
 */
function extractReasonMessage(reason: unknown): string {
  if (reason === undefined || reason === null) return ''
  if (typeof reason === 'string') return reason
  if (reason instanceof Error) return reason.message ?? ''
  if (typeof reason === 'object' && 'message' in reason) {
    const msg = (reason as { message?: unknown }).message
    return typeof msg === 'string' ? msg : ''
  }
  return ''
}

/**
 * Returns <c>true</c> when the disconnect reason points at JWT
 * validation failing (HTTP 401 on the negotiate POST, or SignalR's
 * own FailedToNegotiate wrapper around a 401). Deliberately pattern-
 * matches on strings — SignalR doesn't expose a typed error hierarchy
 * on the browser client, so string-sniffing is the supported path.
 */
export function isAuthFailureReason(reason: unknown): boolean {
  const msg = extractReasonMessage(reason).toLowerCase()
  if (!msg) return false
  return (
    msg.includes('401') ||
    msg.includes('unauthorized') ||
    msg.includes('failedtonegotiate')
  )
}

/**
 * The retry-delay decision point wrapping
 * <see cref="nextReconnectDelayMs"/>. Returns <c>null</c> to stop the
 * retry loop entirely (user must manually refresh / re-login):
 *
 * - Auth failure (401) after <see cref="AUTH_FAILURE_MAX_RETRIES"/>
 *   attempts — no amount of retrying will un-expire the token.
 * - Any reason after <see cref="MAX_TOTAL_RECONNECT_MS"/> of total
 *   elapsed time — bounded resource use for a forgotten tab.
 */
export function nextReconnectDelayForContext(
  ctx: ReconnectRetryContext,
): number | null {
  if (ctx.elapsedMilliseconds > MAX_TOTAL_RECONNECT_MS) return null
  if (
    isAuthFailureReason(ctx.retryReason) &&
    ctx.previousRetryCount >= AUTH_FAILURE_MAX_RETRIES
  ) {
    return null
  }
  return nextReconnectDelayMs(ctx.previousRetryCount)
}
