import { describe, expect, it } from 'vitest'
import type {
  AddSlotRequest,
  CreateMealPlanRequest,
  MealPlanDto,
  MealPlanSlotDto,
  MealSlot,
  PatchSlotRequest,
} from './mealPlanning.ts'

/**
 * Type-level + shape regression tests for the P3-1 meal-planning
 * DTOs. Pins the wire shape with the .NET API so a breaking rename
 * on either side fails here rather than at runtime.
 */

describe('mealPlanning.ts DTOs (P3-1)', () => {
  it('MealPlanSlotDto exposes the full slot shape', () => {
    const slot: MealPlanSlotDto = {
      id: 'slot-1',
      mealPlanId: 'plan-1',
      recipeId: 'r-1',
      recipeTitle: 'Pasta Bolognese',
      label: 'Hauptgericht',
      date: '2026-04-20',
      meal: 'Mittag',
      servings: 2,
      sortOrder: 0,
      isCooked: false,
      parentSlotId: null,
      createdAt: '2026-04-20T10:00:00Z',
      updatedAt: '2026-04-20T10:00:00Z',
    }
    expect(slot.id).toBe('slot-1')
    expect(slot.servings).toBe(2)
    expect(slot.parentSlotId).toBeNull()
    expect(slot.recipeTitle).toBe('Pasta Bolognese')
  })

  it('MealPlanSlotDto.recipeTitle is null for free-text slots', () => {
    const slot: MealPlanSlotDto = {
      id: 'slot-2',
      mealPlanId: 'plan-1',
      recipeId: null,
      recipeTitle: null,
      label: 'Restaurant',
      date: '2026-04-20',
      meal: 'Abend',
      servings: 2,
      sortOrder: 0,
      isCooked: false,
      parentSlotId: null,
      createdAt: '2026-04-20T10:00:00Z',
      updatedAt: '2026-04-20T10:00:00Z',
    }
    expect(slot.recipeTitle).toBeNull()
  })

  it('MealPlanDto nests the slots array', () => {
    const plan: MealPlanDto = {
      id: 'plan-1',
      groupId: 'g-1',
      weekStart: '2026-04-20',
      version: 3,
      createdAt: '2026-04-20T10:00:00Z',
      updatedAt: '2026-04-20T10:00:00Z',
      slots: [],
    }
    expect(plan.slots).toHaveLength(0)
    expect(plan.version).toBe(3)
  })

  it('MealSlot accepts the four canonical buckets', () => {
    // Compile-time check: exhaustive union branches.
    const all: MealSlot[] = ['Frühstück', 'Mittag', 'Abend', 'Snack']
    expect(all).toHaveLength(4)
  })

  it('CreateMealPlanRequest carries only weekStart', () => {
    const body: CreateMealPlanRequest = { weekStart: '2026-04-20' }
    expect(body.weekStart).toBe('2026-04-20')
  })

  it('AddSlotRequest supports recipe-only shape', () => {
    const body: AddSlotRequest = {
      recipeId: 'r-1',
      date: '2026-04-20',
      meal: 'Mittag',
      servings: 4,
    }
    expect(body.recipeId).toBe('r-1')
    expect(body.label).toBeUndefined()
  })

  it('AddSlotRequest supports label-only shape with optional parentSlotId', () => {
    const body: AddSlotRequest = {
      label: 'Restaurant',
      date: '2026-04-22',
      meal: 'Abend',
      servings: 2,
      parentSlotId: null,
    }
    expect(body.label).toBe('Restaurant')
    expect(body.parentSlotId).toBeNull()
  })

  it('PatchSlotRequest allows partial updates with null-clears', () => {
    // Only the fields present in the object are sent to the server;
    // the endpoint uses JSON Merge Patch semantics, so `undefined`
    // keys mean "leave untouched" and `null` means "clear".
    const patchA: PatchSlotRequest = { servings: 5 }
    const patchB: PatchSlotRequest = { label: null }
    const patchC: PatchSlotRequest = { parentSlotId: null, isCooked: true }

    expect(patchA.servings).toBe(5)
    expect(patchB.label).toBeNull()
    expect(patchC.parentSlotId).toBeNull()
    expect(patchC.isCooked).toBe(true)
  })

  it('PatchSlotRequest carries date + meal for cross-cell drag', () => {
    // v0.15.0 — a drag from one (date, meal) bucket to another is
    // expressed as one PATCH carrying the new date + meal (+ optional
    // sortOrder for between-slot insertion).
    const move: PatchSlotRequest = {
      date: '2026-04-22',
      meal: 'Abend',
      sortOrder: 0,
    }
    expect(move.date).toBe('2026-04-22')
    expect(move.meal).toBe('Abend')
    expect(move.sortOrder).toBe(0)
  })
})
