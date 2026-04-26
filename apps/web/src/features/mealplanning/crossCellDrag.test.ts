import { describe, expect, it } from 'vitest'
import type { MealPlanSlotDto } from '@shared-cookbook/shared'
import { CELL_DROPPABLE_PREFIX, parseDragEnd } from './crossCellDrag'
import { SORT_ORDER_STEP } from './constants'

const PLAN_ID = '11111111-1111-1111-1111-111111111111'

function makeSlot(
  id: string,
  date: string,
  meal: 'Mittag' | 'Abend' | 'Frühstück' | 'Snack',
  sortOrder = 0,
): MealPlanSlotDto {
  return {
    id,
    mealPlanId: PLAN_ID,
    recipeId: null,
    recipeTitle: null,
    label: `Slot ${id}`,
    date,
    meal,
    servings: 2,
    sortOrder,
    isCooked: false,
    parentSlotId: null,
    createdAt: '2026-04-20T10:00:00Z',
    updatedAt: '2026-04-20T10:00:00Z',
  }
}

describe('parseDragEnd', () => {
  it('returns null when no over target', () => {
    const slots = [makeSlot('s1', '2026-04-20', 'Mittag')]
    const result = parseDragEnd({
      activeId: 's1',
      overId: null,
      slots,
    })
    expect(result).toBeNull()
  })

  it('returns null when active and over are the same', () => {
    const slots = [makeSlot('s1', '2026-04-20', 'Mittag')]
    const result = parseDragEnd({
      activeId: 's1',
      overId: 's1',
      slots,
    })
    expect(result).toBeNull()
  })

  it('treats drop on a slot in the SAME cell as a same-cell reorder', () => {
    const a = makeSlot('a', '2026-04-20', 'Mittag', 0)
    const b = makeSlot('b', '2026-04-20', 'Mittag', SORT_ORDER_STEP)
    const result = parseDragEnd({
      activeId: 'a',
      overId: 'b',
      slots: [a, b],
    })
    expect(result).toEqual({
      kind: 'same-cell',
      date: '2026-04-20',
      meal: 'Mittag',
      orderedSlotIds: ['b', 'a'],
    })
  })

  it('treats drop on a slot in a DIFFERENT cell as a cross-cell move', () => {
    const a = makeSlot('a', '2026-04-20', 'Mittag', 0)
    const b = makeSlot('b', '2026-04-22', 'Abend', 0)
    const result = parseDragEnd({
      activeId: 'a',
      overId: 'b',
      slots: [a, b],
    })
    // Insert before the target slot — sortOrder of target.
    expect(result).toEqual({
      kind: 'cross-cell',
      slotId: 'a',
      date: '2026-04-22',
      meal: 'Abend',
      sortOrder: 0,
    })
  })

  it('treats drop on a `cell-<date>-<meal>` placeholder as a cross-cell move', () => {
    const a = makeSlot('a', '2026-04-20', 'Mittag', 0)
    const result = parseDragEnd({
      activeId: 'a',
      overId: `${CELL_DROPPABLE_PREFIX}2026-04-22__Abend`,
      slots: [a],
    })
    expect(result).toEqual({
      kind: 'cross-cell',
      slotId: 'a',
      date: '2026-04-22',
      meal: 'Abend',
      sortOrder: 0,
    })
  })

  it('returns null when active slot id is unknown', () => {
    const result = parseDragEnd({
      activeId: 'unknown',
      overId: 'also-unknown',
      slots: [],
    })
    expect(result).toBeNull()
  })
})
