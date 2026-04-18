import { describe, expect, it } from 'vitest'
import { formatRelativeDe } from './relativeTime'

/**
 * `formatRelativeDe` produces compact German "vor X" labels suitable for
 * the recipe-history panel. Pure function — fully deterministic given a
 * fixed `now`.
 */
describe('formatRelativeDe', () => {
  const now = new Date('2026-04-18T12:00:00Z')

  it('returns "gerade eben" for moments under a minute', () => {
    expect(formatRelativeDe(new Date('2026-04-18T11:59:30Z'), now)).toBe('gerade eben')
  })

  it('returns "vor 1 Minute" for ~1 minute ago', () => {
    expect(formatRelativeDe(new Date('2026-04-18T11:59:00Z'), now)).toBe('vor 1 Minute')
  })

  it('returns "vor N Minuten" for several minutes ago', () => {
    expect(formatRelativeDe(new Date('2026-04-18T11:55:00Z'), now)).toBe('vor 5 Minuten')
  })

  it('returns "vor 1 Stunde" for ~1 hour ago', () => {
    expect(formatRelativeDe(new Date('2026-04-18T11:00:00Z'), now)).toBe('vor 1 Stunde')
  })

  it('returns "vor N Stunden" for hours ago', () => {
    expect(formatRelativeDe(new Date('2026-04-18T09:00:00Z'), now)).toBe('vor 3 Stunden')
  })

  it('returns "vor 1 Tag" for ~1 day ago', () => {
    expect(formatRelativeDe(new Date('2026-04-17T12:00:00Z'), now)).toBe('vor 1 Tag')
  })

  it('returns "vor N Tagen" for days ago', () => {
    expect(formatRelativeDe(new Date('2026-04-15T12:00:00Z'), now)).toBe('vor 3 Tagen')
  })

  it('returns "in der Zukunft" for future timestamps (defensive)', () => {
    expect(formatRelativeDe(new Date('2026-04-18T13:00:00Z'), now)).toBe('in der Zukunft')
  })

  it('accepts ISO strings', () => {
    expect(formatRelativeDe('2026-04-18T11:55:00Z', now)).toBe('vor 5 Minuten')
  })
})
