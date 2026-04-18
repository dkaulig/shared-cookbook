import { describe, expect, it } from 'vitest'
import type { TagDto } from '@familien-kochbuch/shared'
import {
  applyFilterPreset,
  currentSeasonTagName,
  type FilterPreset,
} from './presets'

/**
 * DS4 URL presets — Home-page quick-filter chips navigate into the Group
 * Detail page with `?preset=...`. The filter panel consumes these and
 * pre-selects the matching filter(s). Tested at the helper boundary so
 * the logic stays pure regardless of React state wiring.
 */

const tags: TagDto[] = [
  { id: 't-quick', name: 'schnell', category: 'Aufwand', isGlobal: true, groupId: null, createdByUserId: null },
  { id: 't-warm', name: 'warm', category: 'Typ', isGlobal: true, groupId: null, createdByUserId: null },
  { id: 't-veggie', name: 'vegetarisch', category: 'Diaet', isGlobal: true, groupId: null, createdByUserId: null },
  { id: 't-spring', name: 'Frühling', category: 'Saison', isGlobal: true, groupId: null, createdByUserId: null },
  { id: 't-summer', name: 'Sommer', category: 'Saison', isGlobal: true, groupId: null, createdByUserId: null },
  { id: 't-autumn', name: 'Herbst', category: 'Saison', isGlobal: true, groupId: null, createdByUserId: null },
  { id: 't-winter', name: 'Winter', category: 'Saison', isGlobal: true, groupId: null, createdByUserId: null },
]

describe('applyFilterPreset', () => {
  it('quick preset sets maxPrepTime to 30 and selects the "schnell" tag', () => {
    const next = applyFilterPreset({}, 'quick', tags)
    expect(next.maxPrepTime).toBe(30)
    expect(next.tags).toContain('t-quick')
  })

  it('warm preset selects the "warm" tag', () => {
    const next = applyFilterPreset({}, 'warm', tags)
    expect(next.tags).toContain('t-warm')
  })

  it('veggie preset selects the "vegetarisch" tag', () => {
    const next = applyFilterPreset({}, 'veggie', tags)
    expect(next.tags).toContain('t-veggie')
  })

  it('easy preset selects the "schnell" tag (alias for quick-ish workload)', () => {
    const next = applyFilterPreset({}, 'easy', tags)
    expect(next.tags).toContain('t-quick')
  })

  it('season preset selects the tag matching the current season', () => {
    // February → Winter
    const feb = new Date(2026, 1, 15)
    const nextFeb = applyFilterPreset({}, 'season', tags, feb)
    expect(nextFeb.tags).toContain('t-winter')

    // May → Frühling
    const may = new Date(2026, 4, 15)
    const nextMay = applyFilterPreset({}, 'season', tags, may)
    expect(nextMay.tags).toContain('t-spring')

    // July → Sommer
    const jul = new Date(2026, 6, 15)
    const nextJul = applyFilterPreset({}, 'season', tags, jul)
    expect(nextJul.tags).toContain('t-summer')

    // October → Herbst
    const oct = new Date(2026, 9, 15)
    const nextOct = applyFilterPreset({}, 'season', tags, oct)
    expect(nextOct.tags).toContain('t-autumn')
  })

  it('does not duplicate an already-selected tag', () => {
    const next = applyFilterPreset({ tags: ['t-quick'] }, 'quick', tags)
    const occurrences = (next.tags ?? []).filter((id) => id === 't-quick')
    expect(occurrences).toHaveLength(1)
  })

  it('gracefully no-ops when the matching tag is missing', () => {
    const limited: TagDto[] = [
      { id: 't-other', name: 'other', category: 'Custom', isGlobal: false, groupId: 'g1', createdByUserId: null },
    ]
    const next = applyFilterPreset({}, 'warm', limited)
    // warm should have tried to pick a tag named "warm" — it's not there,
    // so the filter state is returned untouched.
    expect(next.tags ?? []).toEqual([])
  })

  it('rejects unknown preset names by returning the input untouched', () => {
    const input = { q: 'keeps me' }
    const next = applyFilterPreset(input, 'bogus' as FilterPreset, tags)
    expect(next).toStrictEqual(input)
  })

  it('random preset is signalled to the caller but does not mutate filters', () => {
    // The caller handles the navigation side-effect; the helper must not
    // add filters for "random" because it has no tag mapping.
    const next = applyFilterPreset({ q: 'x' }, 'random', tags)
    expect(next).toStrictEqual({ q: 'x' })
  })
})

describe('currentSeasonTagName', () => {
  it('Dec/Jan/Feb → Winter', () => {
    expect(currentSeasonTagName(new Date(2026, 0, 1))).toBe('Winter')
    expect(currentSeasonTagName(new Date(2026, 1, 15))).toBe('Winter')
    expect(currentSeasonTagName(new Date(2026, 11, 15))).toBe('Winter')
  })
  it('Mar/Apr/May → Frühling', () => {
    expect(currentSeasonTagName(new Date(2026, 2, 15))).toBe('Frühling')
    expect(currentSeasonTagName(new Date(2026, 4, 15))).toBe('Frühling')
  })
  it('Jun/Jul/Aug → Sommer', () => {
    expect(currentSeasonTagName(new Date(2026, 5, 15))).toBe('Sommer')
    expect(currentSeasonTagName(new Date(2026, 7, 15))).toBe('Sommer')
  })
  it('Sep/Oct/Nov → Herbst', () => {
    expect(currentSeasonTagName(new Date(2026, 8, 15))).toBe('Herbst')
    expect(currentSeasonTagName(new Date(2026, 10, 15))).toBe('Herbst')
  })
})
