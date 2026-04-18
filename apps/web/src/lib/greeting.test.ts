import { describe, expect, it } from 'vitest'
import { localeTimeGreeting } from './greeting'

/**
 * Wall-clock → German greeting helper used by the Home page hero's
 * kicker line. Four buckets — Morgen (5-11), Tag (12-17), Abend
 * (18-22), Nacht (23-4).
 */
describe('localeTimeGreeting', () => {
  it('returns "Guten Morgen" between 5 and 11', () => {
    expect(localeTimeGreeting(new Date('2026-04-17T05:00:00'))).toBe('Guten Morgen')
    expect(localeTimeGreeting(new Date('2026-04-17T09:30:00'))).toBe('Guten Morgen')
    expect(localeTimeGreeting(new Date('2026-04-17T11:59:00'))).toBe('Guten Morgen')
  })

  it('returns "Guten Tag" between 12 and 17', () => {
    expect(localeTimeGreeting(new Date('2026-04-17T12:00:00'))).toBe('Guten Tag')
    expect(localeTimeGreeting(new Date('2026-04-17T15:45:00'))).toBe('Guten Tag')
    expect(localeTimeGreeting(new Date('2026-04-17T17:59:00'))).toBe('Guten Tag')
  })

  it('returns "Guten Abend" between 18 and 22', () => {
    expect(localeTimeGreeting(new Date('2026-04-17T18:00:00'))).toBe('Guten Abend')
    expect(localeTimeGreeting(new Date('2026-04-17T20:30:00'))).toBe('Guten Abend')
    expect(localeTimeGreeting(new Date('2026-04-17T22:59:00'))).toBe('Guten Abend')
  })

  it('returns "Gute Nacht" between 23 and 4', () => {
    expect(localeTimeGreeting(new Date('2026-04-17T23:00:00'))).toBe('Gute Nacht')
    expect(localeTimeGreeting(new Date('2026-04-17T01:15:00'))).toBe('Gute Nacht')
    expect(localeTimeGreeting(new Date('2026-04-17T04:59:00'))).toBe('Gute Nacht')
  })
})
