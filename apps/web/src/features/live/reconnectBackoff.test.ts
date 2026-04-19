import { describe, expect, it } from 'vitest'
import {
  RECONNECT_BACKOFF_SCHEDULE_MS,
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
