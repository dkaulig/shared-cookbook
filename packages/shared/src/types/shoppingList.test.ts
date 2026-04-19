import { describe, expect, it } from 'vitest'
import type {
  AddShoppingListItemRequest,
  IngredientCategory,
  PatchShoppingListItemRequest,
  ShoppingListDto,
  ShoppingListItemDto,
  ShoppingListItemSource,
} from './shoppingList.ts'

/**
 * Type-level + shape regression tests for the P3-5 shopping-list
 * DTOs. Pins the wire shape with the .NET API so a breaking rename
 * on either side fails here rather than at runtime.
 */

describe('shoppingList.ts DTOs (P3-5)', () => {
  it('ShoppingListItemDto exposes every field the API returns', () => {
    const item: ShoppingListItemDto = {
      id: 'item-1',
      shoppingListId: 'list-1',
      name: 'Tomaten',
      quantity: '500',
      unit: 'g',
      note: null,
      isChecked: false,
      category: 'Sonstiges',
      source: 'FromPlan',
      sortOrder: 0,
      carriedOverFromPreviousWeek: false,
      createdAt: '2026-04-20T10:00:00Z',
      updatedAt: '2026-04-20T10:00:00Z',
    }
    expect(item.name).toBe('Tomaten')
    expect(item.quantity).toBe('500')
    expect(item.isChecked).toBe(false)
  })

  it('ShoppingListDto nests the items array', () => {
    const list: ShoppingListDto = {
      id: 'list-1',
      mealPlanId: 'plan-1',
      createdAt: '2026-04-20T10:00:00Z',
      updatedAt: '2026-04-20T10:00:00Z',
      lastGeneratedAt: '2026-04-20T10:00:00Z',
      items: [],
    }
    expect(list.items).toHaveLength(0)
    expect(list.mealPlanId).toBe('plan-1')
  })

  it('IngredientCategory starts minimal (Sonstiges only) for P3-5', () => {
    // P3-6 will expand this union; for now the sole legal literal is
    // "Sonstiges". Kept narrow so a typo in the API reply is caught
    // by TypeScript rather than passed through silently.
    const c: IngredientCategory = 'Sonstiges'
    expect(c).toBe('Sonstiges')
  })

  it('ShoppingListItemSource covers all three provenance values', () => {
    const sources: ShoppingListItemSource[] = ['FromPlan', 'Manual', 'CarriedOver']
    expect(sources).toHaveLength(3)
  })

  it('AddShoppingListItemRequest supports name-only shape', () => {
    const body: AddShoppingListItemRequest = { name: 'Klopapier' }
    expect(body.name).toBe('Klopapier')
    expect(body.unit).toBeUndefined()
  })

  it('AddShoppingListItemRequest supports full shape with note + category', () => {
    const body: AddShoppingListItemRequest = {
      name: 'Äpfel',
      quantity: '1',
      unit: 'kg',
      note: 'bio wenn möglich',
      category: 'Sonstiges',
    }
    expect(body.quantity).toBe('1')
    expect(body.category).toBe('Sonstiges')
  })

  it('PatchShoppingListItemRequest allows partial updates', () => {
    // Only fields present in the object are sent to the server.
    // JSON Merge Patch: undefined → leave alone, null → clear (only
    // `note` supports clearing).
    const patchA: PatchShoppingListItemRequest = { isChecked: true }
    const patchB: PatchShoppingListItemRequest = { note: null }
    const patchC: PatchShoppingListItemRequest = { note: 'bio' }

    expect(patchA.isChecked).toBe(true)
    expect(patchB.note).toBeNull()
    expect(patchC.note).toBe('bio')
  })

  it('CarriedOverFromPreviousWeek flag appears on item DTO', () => {
    // The UI keys off this flag to render the "↺ aus letzter Woche"
    // badge — pin it at the type level so a rename on the server
    // surfaces here.
    const item: ShoppingListItemDto = {
      id: 'i',
      shoppingListId: 'l',
      name: 'Avocado',
      quantity: '2',
      unit: 'Stück',
      note: null,
      isChecked: false,
      category: 'Sonstiges',
      source: 'CarriedOver',
      sortOrder: 0,
      carriedOverFromPreviousWeek: true,
      createdAt: '2026-04-20T10:00:00Z',
      updatedAt: '2026-04-20T10:00:00Z',
    }
    expect(item.carriedOverFromPreviousWeek).toBe(true)
    expect(item.source).toBe('CarriedOver')
  })
})
