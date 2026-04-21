import { describe, expect, it } from 'vitest'
import { MIN_SERVINGS, MAX_SERVINGS, clampPortions } from './portions'

describe('portions constants', () => {
  it('uses MIN=1, MAX=99 (kitchen-practical range)', () => {
    expect(MIN_SERVINGS).toBe(1)
    expect(MAX_SERVINGS).toBe(99)
  })
})

describe('clampPortions', () => {
  it('returns in-range integers unchanged', () => {
    expect(clampPortions(4)).toBe(4)
    expect(clampPortions(1)).toBe(1)
    expect(clampPortions(99)).toBe(99)
  })

  it('rounds fractional values to the nearest integer', () => {
    expect(clampPortions(2.4)).toBe(2)
    expect(clampPortions(2.6)).toBe(3)
    // Math.round rounds half-to-even-or-up — spec is "nearest integer".
    expect(clampPortions(2.5)).toBe(3)
  })

  it('clamps below MIN to 1', () => {
    expect(clampPortions(0)).toBe(1)
    expect(clampPortions(-5)).toBe(1)
  })

  it('clamps above MAX to 99', () => {
    expect(clampPortions(100)).toBe(99)
    expect(clampPortions(1_000_000)).toBe(99)
  })

  it('collapses NaN / Infinity to MIN', () => {
    expect(clampPortions(Number.NaN)).toBe(1)
    expect(clampPortions(Number.POSITIVE_INFINITY)).toBe(1)
    expect(clampPortions(Number.NEGATIVE_INFINITY)).toBe(1)
  })
})
