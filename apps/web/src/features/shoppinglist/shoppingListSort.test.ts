import { describe, expect, it } from 'vitest'
import type {
  IngredientCategory,
  ShoppingListItemDto,
} from '@familien-kochbuch/shared'
import { byCategory, byName } from './shoppingListSort'

function makeItem(
  overrides: Partial<ShoppingListItemDto> & { id: string; name: string },
): ShoppingListItemDto {
  return {
    id: overrides.id,
    shoppingListId: 'list-1',
    name: overrides.name,
    quantity: null,
    unit: null,
    note: null,
    isChecked: false,
    category: 'Sonstiges',
    source: 'FromPlan',
    sortOrder: 0,
    carriedOverFromPreviousWeek: false,
    createdAt: '2026-04-19T00:00:00Z',
    updatedAt: '2026-04-19T00:00:00Z',
    ...overrides,
  }
}

describe('byCategory', () => {
  it('returns buckets in canonical CATEGORY_ORDER sequence', () => {
    const items = [
      makeItem({ id: 'h', name: 'Spülmittel', category: 'Haushalt' }),
      makeItem({ id: 'og', name: 'Tomate', category: 'ObstGemuese' }),
      makeItem({ id: 's', name: 'Strohhalme', category: 'Sonstiges' }),
      makeItem({ id: 'fm', name: 'Milch', category: 'Molkerei' }),
    ]
    const buckets = byCategory(items)
    expect(buckets.map((b) => b.category)).toEqual([
      'ObstGemuese',
      'Molkerei',
      'Haushalt',
      'Sonstiges',
    ] satisfies IngredientCategory[])
  })

  it('drops categories that have no items', () => {
    const items = [
      makeItem({ id: '1', name: 'Paprika', category: 'ObstGemuese' }),
    ]
    const buckets = byCategory(items)
    expect(buckets).toHaveLength(1)
    expect(buckets[0]?.category).toBe('ObstGemuese')
  })

  it('sorts within a category by sortOrder ascending then by name', () => {
    const items = [
      makeItem({
        id: 'a',
        name: 'Banane',
        category: 'ObstGemuese',
        sortOrder: 20,
      }),
      makeItem({
        id: 'b',
        name: 'Apfel',
        category: 'ObstGemuese',
        sortOrder: 10,
      }),
      makeItem({
        id: 'c',
        name: 'Zwiebel',
        category: 'ObstGemuese',
        sortOrder: 10,
      }),
    ]
    const buckets = byCategory(items)
    const names = buckets[0]?.items.map((i) => i.name)
    // sortOrder=10 (Apfel, Zwiebel) then sortOrder=20 (Banane). Within
    // the same sortOrder the name-tiebreak orders alphabetically.
    expect(names).toEqual(['Apfel', 'Zwiebel', 'Banane'])
  })

  it('handles an empty input', () => {
    expect(byCategory([])).toEqual([])
  })

  it('does not mutate the input array', () => {
    const items = [
      makeItem({
        id: 'a',
        name: 'Z',
        category: 'ObstGemuese',
        sortOrder: 30,
      }),
      makeItem({
        id: 'b',
        name: 'A',
        category: 'ObstGemuese',
        sortOrder: 10,
      }),
    ]
    const snapshot = items.map((i) => i.id)
    byCategory(items)
    expect(items.map((i) => i.id)).toEqual(snapshot)
  })
})

describe('byName', () => {
  it('sorts alphabetically with German locale (umlauts next to base letter)', () => {
    const items = [
      makeItem({ id: '1', name: 'Banane' }),
      makeItem({ id: '2', name: 'Äpfel' }),
      makeItem({ id: '3', name: 'Möhre' }),
      makeItem({ id: '4', name: 'Nudeln' }),
    ]
    expect(byName(items).map((i) => i.name)).toEqual([
      'Äpfel',
      'Banane',
      'Möhre',
      'Nudeln',
    ])
  })

  it('is case-insensitive', () => {
    const items = [
      makeItem({ id: '1', name: 'butter' }),
      makeItem({ id: '2', name: 'Apfel' }),
      makeItem({ id: '3', name: 'ZUCKER' }),
    ]
    expect(byName(items).map((i) => i.name)).toEqual([
      'Apfel',
      'butter',
      'ZUCKER',
    ])
  })

  it('is stable for equal names (tie-breaks by id)', () => {
    const items = [
      makeItem({ id: 'b', name: 'Salz' }),
      makeItem({ id: 'a', name: 'Salz' }),
    ]
    expect(byName(items).map((i) => i.id)).toEqual(['a', 'b'])
  })

  it('does not mutate the input array', () => {
    const items = [
      makeItem({ id: '1', name: 'Zucker' }),
      makeItem({ id: '2', name: 'Apfel' }),
    ]
    const snapshot = items.map((i) => i.id)
    byName(items)
    expect(items.map((i) => i.id)).toEqual(snapshot)
  })

  it('returns an empty array for empty input', () => {
    expect(byName([])).toEqual([])
  })
})
