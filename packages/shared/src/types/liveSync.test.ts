import { describe, expect, it } from 'vitest'
import {
  LiveSyncEventNames,
  type LiveSyncEventName,
  type MealPlanChangedPayload,
  type MealPlanSlotChangedPayload,
  type ShoppingListItemChangedPayload,
} from './liveSync.ts'

describe('LiveSyncEventNames', () => {
  it('exposes the three documented event names as string literals', () => {
    expect(LiveSyncEventNames.MealPlanSlotChanged).toBe('MealPlanSlotChanged')
    expect(LiveSyncEventNames.MealPlanChanged).toBe('MealPlanChanged')
    expect(LiveSyncEventNames.ShoppingListItemChanged).toBe(
      'ShoppingListItemChanged',
    )
  })

  it('is assignable to LiveSyncEventName union', () => {
    const name: LiveSyncEventName = LiveSyncEventNames.MealPlanSlotChanged
    expect(name).toBe('MealPlanSlotChanged')
  })
})

describe('MealPlanSlotChangedPayload', () => {
  it('accepts a fully populated payload', () => {
    const payload: MealPlanSlotChangedPayload = {
      planId: '11111111-1111-1111-1111-111111111111',
      slotId: '22222222-2222-2222-2222-222222222222',
      groupId: '33333333-3333-3333-3333-333333333333',
      weekStart: '2026-04-20',
      action: 'updated',
    }
    expect(payload.action).toBe('updated')
    expect(payload.weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('MealPlanChangedPayload', () => {
  it('accepts a created action without slotId', () => {
    const payload: MealPlanChangedPayload = {
      planId: '11111111-1111-1111-1111-111111111111',
      groupId: '33333333-3333-3333-3333-333333333333',
      weekStart: '2026-04-20',
      action: 'created',
    }
    expect(payload.action).toBe('created')
  })
})

describe('ShoppingListItemChangedPayload', () => {
  it('carries list + item + plan ids', () => {
    const payload: ShoppingListItemChangedPayload = {
      listId: '44444444-4444-4444-4444-444444444444',
      itemId: '55555555-5555-5555-5555-555555555555',
      planId: '11111111-1111-1111-1111-111111111111',
      action: 'deleted',
    }
    expect(payload.action).toBe('deleted')
  })
})
