import { describe, expect, it } from 'vitest'
import {
  AUTH_FAILURE_MAX_RETRIES,
  MAX_TOTAL_RECONNECT_MS,
  RECONNECT_BACKOFF_SCHEDULE_MS,
  isAuthFailureReason,
  nextReconnectDelayForContext,
  nextReconnectDelayMs,
} from './reconnectBackoff'

describe('reconnectBackoff', () => {
  it('starts at 500ms for the first retry', () => {
    expect(nextReconnectDelayMs(0)).toBe(500)
  })

  it('is monotonically non-decreasing', () => {
    const delays: number[] = []
    for (let i = 0; i < RECONNECT_BACKOFF_SCHEDULE_MS.length + 2; i++) {
      delays.push(nextReconnectDelayMs(i))
    }
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1])
    }
  })

  it('caps at 30 seconds past the schedule', () => {
    expect(nextReconnectDelayMs(99)).toBe(30000)
    expect(nextReconnectDelayMs(9999)).toBe(30000)
  })

  it('matches the documented 500/1000/2000/5000/10000/30000 schedule', () => {
    expect(RECONNECT_BACKOFF_SCHEDULE_MS).toEqual([
      500, 1000, 2000, 5000, 10000, 30000,
    ])
  })

  it('guards against negative retryCount by falling back to the first step', () => {
    expect(nextReconnectDelayMs(-1)).toBe(500)
    expect(nextReconnectDelayMs(-5)).toBe(500)
  })
})

describe('isAuthFailureReason', () => {
  it('recognises a 401 Error', () => {
    expect(isAuthFailureReason(new Error('Status code 401'))).toBe(true)
  })

  it('recognises an Unauthorized phrase', () => {
    expect(isAuthFailureReason(new Error('Unauthorized'))).toBe(true)
  })

  it('recognises SignalR FailedToNegotiate', () => {
    expect(
      isAuthFailureReason(new Error('FailedToNegotiateWithServerError')),
    ).toBe(true)
  })

  it('does not treat transport blips as auth failure', () => {
    expect(
      isAuthFailureReason(new Error('WebSocket closed: transport error')),
    ).toBe(false)
  })

  it('handles missing reason defensively', () => {
    expect(isAuthFailureReason(undefined)).toBe(false)
    expect(isAuthFailureReason(null)).toBe(false)
    expect(isAuthFailureReason({})).toBe(false)
  })
})

describe('nextReconnectDelayForContext', () => {
  it('uses the standard schedule for a generic transient failure', () => {
    expect(
      nextReconnectDelayForContext({
        previousRetryCount: 0,
        elapsedMilliseconds: 0,
        retryReason: new Error('WebSocket closed: transport error'),
      }),
    ).toBe(500)
    expect(
      nextReconnectDelayForContext({
        previousRetryCount: 2,
        elapsedMilliseconds: 3000,
        retryReason: new Error('WebSocket closed'),
      }),
    ).toBe(2000)
  })

  it('surrenders after the configured auth-failure cap on repeated 401s', () => {
    // First AUTH_FAILURE_MAX_RETRIES attempts use the schedule...
    for (let i = 0; i < AUTH_FAILURE_MAX_RETRIES; i++) {
      const delay = nextReconnectDelayForContext({
        previousRetryCount: i,
        elapsedMilliseconds: 1000,
        retryReason: new Error('Status code 401'),
      })
      expect(delay).not.toBeNull()
      expect(delay).toBeGreaterThanOrEqual(500)
    }

    // ... then the (AUTH_FAILURE_MAX_RETRIES + 1)th call returns null.
    expect(
      nextReconnectDelayForContext({
        previousRetryCount: AUTH_FAILURE_MAX_RETRIES,
        elapsedMilliseconds: 1000,
        retryReason: new Error('Status code 401'),
      }),
    ).toBeNull()
  })

  it('keeps retrying transient errors past the auth-failure cap', () => {
    // Same retry count as the 401-stop case, but reason is NOT auth —
    // must still return a delay (not null).
    expect(
      nextReconnectDelayForContext({
        previousRetryCount: AUTH_FAILURE_MAX_RETRIES,
        elapsedMilliseconds: 1000,
        retryReason: new Error('WebSocket closed'),
      }),
    ).not.toBeNull()
  })

  it('surrenders once elapsed time crosses the total-reconnect cap', () => {
    expect(
      nextReconnectDelayForContext({
        previousRetryCount: 1,
        elapsedMilliseconds: MAX_TOTAL_RECONNECT_MS + 1,
        retryReason: new Error('WebSocket closed'),
      }),
    ).toBeNull()
  })

  it('still serves a delay when elapsed is exactly at the cap', () => {
    // Strict > in the implementation — boundary stays retryable.
    expect(
      nextReconnectDelayForContext({
        previousRetryCount: 1,
        elapsedMilliseconds: MAX_TOTAL_RECONNECT_MS,
        retryReason: new Error('WebSocket closed'),
      }),
    ).not.toBeNull()
  })
})
