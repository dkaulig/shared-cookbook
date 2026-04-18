import { describe, expect, it } from 'vitest'
import { seasonalEveningLabel } from './seasonalLabel'

/**
 * The seasonal label swaps between "Winter-Abend" and "Sommer-Abend"
 * purely based on the month component of the supplied date. Months
 * November (index 10), December (11), January (0) and February (1)
 * count as Winter — the remaining months render as Sommer.
 */
describe('seasonalEveningLabel', () => {
  it('returns "Winter-Abend" in November', () => {
    expect(seasonalEveningLabel(new Date('2026-11-15T19:00:00Z'))).toBe('Winter-Abend')
  })

  it('returns "Winter-Abend" in December', () => {
    expect(seasonalEveningLabel(new Date('2026-12-24T19:00:00Z'))).toBe('Winter-Abend')
  })

  it('returns "Winter-Abend" in January', () => {
    expect(seasonalEveningLabel(new Date('2026-01-10T19:00:00Z'))).toBe('Winter-Abend')
  })

  it('returns "Winter-Abend" in February', () => {
    expect(seasonalEveningLabel(new Date('2026-02-28T19:00:00Z'))).toBe('Winter-Abend')
  })

  it('returns "Sommer-Abend" in March through October', () => {
    expect(seasonalEveningLabel(new Date('2026-03-01T19:00:00Z'))).toBe('Sommer-Abend')
    expect(seasonalEveningLabel(new Date('2026-06-21T19:00:00Z'))).toBe('Sommer-Abend')
    expect(seasonalEveningLabel(new Date('2026-10-31T19:00:00Z'))).toBe('Sommer-Abend')
  })
})
