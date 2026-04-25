import { describe, expect, it } from 'vitest'
import type { MealPlanSlotDto, MealSlot } from '@shared-cookbook/shared'
import {
  buildParentLabel,
  childrenOf,
  eligibleParents,
  findDescendantIds,
} from './parentSlotHelpers'

const PLAN_ID = '00000000-0000-0000-0000-000000000000'

function makeSlot(
  id: string,
  overrides: Partial<MealPlanSlotDto> = {},
): MealPlanSlotDto {
  return {
    id,
    mealPlanId: PLAN_ID,
    recipeId: null,
    label: `Slot ${id}`,
    date: '2026-04-20',
    meal: 'Mittag' as MealSlot,
    servings: 2,
    sortOrder: 0,
    isCooked: false,
    parentSlotId: null,
    createdAt: '2026-04-20T10:00:00Z',
    updatedAt: '2026-04-20T10:00:00Z',
    ...overrides,
  }
}

describe('childrenOf', () => {
  it('returns only direct children — not grandchildren', () => {
    const a = makeSlot('a')
    const b = makeSlot('b', { parentSlotId: 'a' })
    const c = makeSlot('c', { parentSlotId: 'b' })
    const d = makeSlot('d', { parentSlotId: 'a' })
    expect(childrenOf('a', [a, b, c, d]).map((s) => s.id).sort()).toEqual([
      'b',
      'd',
    ])
  })

  it('returns an empty array when the slot has no children', () => {
    const a = makeSlot('a')
    const b = makeSlot('b')
    expect(childrenOf('a', [a, b])).toEqual([])
  })
})

describe('findDescendantIds', () => {
  it('returns an empty set for a leaf slot (0-depth)', () => {
    const a = makeSlot('a')
    const b = makeSlot('b')
    const result = findDescendantIds('a', [a, b])
    expect(result.size).toBe(0)
  })

  it('returns the direct child set for 1-depth', () => {
    const a = makeSlot('a')
    const b = makeSlot('b', { parentSlotId: 'a' })
    const c = makeSlot('c', { parentSlotId: 'a' })
    const result = findDescendantIds('a', [a, b, c])
    expect([...result].sort()).toEqual(['b', 'c'])
  })

  it('traverses 2-depth chains (A → B → C)', () => {
    const a = makeSlot('a')
    const b = makeSlot('b', { parentSlotId: 'a' })
    const c = makeSlot('c', { parentSlotId: 'b' })
    const result = findDescendantIds('a', [a, b, c])
    expect([...result].sort()).toEqual(['b', 'c'])
  })

  it('terminates on malformed cyclic data without hanging', () => {
    // Backend should never ship a cycle (domain-check prevents it) but
    // the frontend stays defensive so a bad cache entry can't hang the
    // UI. Expect traversal to include every reachable id exactly once.
    const a = makeSlot('a', { parentSlotId: 'b' })
    const b = makeSlot('b', { parentSlotId: 'a' })
    const result = findDescendantIds('a', [a, b])
    expect([...result].sort()).toEqual(['a', 'b'])
  })
})

describe('eligibleParents', () => {
  it('excludes the slot being edited', () => {
    const a = makeSlot('a')
    const b = makeSlot('b')
    const result = eligibleParents('a', [a, b])
    expect(result.map((s) => s.id)).toEqual(['b'])
  })

  it('excludes descendants of the editing slot (cycle prevention)', () => {
    const a = makeSlot('a')
    const b = makeSlot('b', { parentSlotId: 'a' })
    const c = makeSlot('c', { parentSlotId: 'b' })
    const d = makeSlot('d') // independent
    // Editing A — picking B or C as A's parent would create a cycle.
    const result = eligibleParents('a', [a, b, c, d])
    expect(result.map((s) => s.id)).toEqual(['d'])
  })

  it('returns all slots when creating (editingSlotId is null)', () => {
    const a = makeSlot('a')
    const b = makeSlot('b')
    const result = eligibleParents(null, [a, b])
    expect(result.map((s) => s.id).sort()).toEqual(['a', 'b'])
  })

  it('sorts chronologically (date asc, then meal order, then sortOrder)', () => {
    const mondayAbend = makeSlot('mon-abend', {
      date: '2026-04-20',
      meal: 'Abend',
      sortOrder: 0,
    })
    const mondayMittag = makeSlot('mon-mittag', {
      date: '2026-04-20',
      meal: 'Mittag',
      sortOrder: 0,
    })
    const tuesdayMittag = makeSlot('tue-mittag', {
      date: '2026-04-21',
      meal: 'Mittag',
      sortOrder: 0,
    })
    const mondayMittag2 = makeSlot('mon-mittag-2', {
      date: '2026-04-20',
      meal: 'Mittag',
      sortOrder: 10,
    })

    // Deliberately shuffled input so we know the sort is doing the work.
    const result = eligibleParents(null, [
      tuesdayMittag,
      mondayAbend,
      mondayMittag2,
      mondayMittag,
    ])
    expect(result.map((s) => s.id)).toEqual([
      'mon-mittag',
      'mon-mittag-2',
      'mon-abend',
      'tue-mittag',
    ])
  })
})

describe('buildParentLabel', () => {
  it('formats the long label as "Wd Meal: Title (N Portionen)"', () => {
    const parent = makeSlot('p', {
      date: '2026-04-20', // Monday
      meal: 'Mittag',
      label: 'Gulasch',
      servings: 4,
    })
    expect(buildParentLabel(parent)).toBe('Mo Mittag: Gulasch (4 Portionen)')
  })

  it('uses "Portion" singular for servings = 1', () => {
    const parent = makeSlot('p', {
      date: '2026-04-20',
      meal: 'Mittag',
      label: 'Suppe',
      servings: 1,
    })
    expect(buildParentLabel(parent)).toBe('Mo Mittag: Suppe (1 Portion)')
  })

  it('emits the short "Wd Meal" form when short=true', () => {
    const parent = makeSlot('p', {
      date: '2026-04-22', // Wednesday
      meal: 'Abend',
      label: 'Linsencurry',
      servings: 5,
    })
    expect(buildParentLabel(parent, { short: true })).toBe('Mi Abend')
  })

  it('falls back to "Rezept" when label is blank but a recipe is linked', () => {
    const parent = makeSlot('p', {
      date: '2026-04-20',
      meal: 'Mittag',
      label: '   ',
      recipeId: '11111111-1111-1111-1111-111111111111',
      servings: 2,
    })
    expect(buildParentLabel(parent)).toBe('Mo Mittag: Rezept (2 Portionen)')
  })
})
