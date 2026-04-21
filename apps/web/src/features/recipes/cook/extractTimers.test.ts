import { describe, expect, it } from 'vitest'
import { extractTimers } from './extractTimers'

describe('extractTimers — basic units', () => {
  it('matches "10 Minuten ziehen lassen" → 1 timer, 600 s', () => {
    const timers = extractTimers('10 Minuten ziehen lassen')
    expect(timers).toHaveLength(1)
    expect(timers[0]!.seconds).toBe(600)
    expect(timers[0]!.label).toBe('10 Minuten')
  })

  it('matches "2 Stunden im Ofen" → 1 timer, 7200 s', () => {
    const timers = extractTimers('2 Stunden im Ofen')
    expect(timers).toHaveLength(1)
    expect(timers[0]!.seconds).toBe(7200)
  })

  it('matches "30 Sekunden aufkochen" → 1 timer, 30 s', () => {
    const timers = extractTimers('30 Sekunden aufkochen')
    expect(timers).toHaveLength(1)
    expect(timers[0]!.seconds).toBe(30)
  })

  it('matches "5 min" short form', () => {
    const timers = extractTimers('5 min rühren')
    expect(timers).toHaveLength(1)
    expect(timers[0]!.seconds).toBe(300)
  })

  it('matches "3h" without space', () => {
    const timers = extractTimers('3h marinieren')
    expect(timers).toHaveLength(1)
    expect(timers[0]!.seconds).toBe(3 * 3600)
  })

  it('matches "Min." abbreviated with period', () => {
    const timers = extractTimers('7 Min. köcheln')
    expect(timers).toHaveLength(1)
    expect(timers[0]!.seconds).toBe(7 * 60)
  })
})

describe('extractTimers — range forms (upper bound)', () => {
  it('"5-7 Minuten köcheln" → 1 timer, 420 s (upper bound)', () => {
    const timers = extractTimers('5-7 Minuten köcheln')
    expect(timers).toHaveLength(1)
    expect(timers[0]!.seconds).toBe(7 * 60)
  })

  it('"2-3 Stunden schmoren" → 1 timer, 10800 s (upper-bound)', () => {
    const timers = extractTimers('2-3 Stunden schmoren')
    expect(timers).toHaveLength(1)
    expect(timers[0]!.seconds).toBe(3 * 3600)
  })

  it('supports en-dash "10–15 min"', () => {
    const timers = extractTimers('10–15 min rühren')
    expect(timers).toHaveLength(1)
    expect(timers[0]!.seconds).toBe(15 * 60)
  })

  it('does not also match inner values (overlap dedupe)', () => {
    const timers = extractTimers('2-3 Stunden schmoren')
    expect(timers).toHaveLength(1)
  })
})

describe('extractTimers — multiple timers in one step', () => {
  it('"nach 2 min, dann 3 min später" → 2 timers (120, 180)', () => {
    const timers = extractTimers('nach 2 min, dann 3 min später')
    expect(timers).toHaveLength(2)
    expect(timers[0]!.seconds).toBe(120)
    expect(timers[1]!.seconds).toBe(180)
  })

  it('"10 Minuten und 30 Sekunden" → 2 timers (600, 30)', () => {
    const timers = extractTimers('10 Minuten und 30 Sekunden')
    expect(timers).toHaveLength(2)
    expect(timers[0]!.seconds).toBe(600)
    expect(timers[1]!.seconds).toBe(30)
  })

  it('returns timers sorted by matchStart', () => {
    const timers = extractTimers('Erst 10 Min, dann 2 Std')
    expect(timers).toHaveLength(2)
    expect(timers[0]!.matchStart).toBeLessThan(timers[1]!.matchStart)
  })
})

describe('extractTimers — negative / edge cases', () => {
  it('"ein paar Minuten" → 0 timers (no numeric)', () => {
    expect(extractTimers('ein paar Minuten')).toHaveLength(0)
  })

  it('empty string → []', () => {
    expect(extractTimers('')).toEqual([])
  })

  it('no digits → []', () => {
    expect(extractTimers('nach Geschmack würzen')).toEqual([])
  })
})
