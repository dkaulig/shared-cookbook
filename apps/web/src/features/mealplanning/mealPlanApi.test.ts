import { beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import type { MealPlanSlotDto } from '@familien-kochbuch/shared'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { deleteSlot, patchSlot } from './mealPlanApi'

const PLAN_ID = '11111111-1111-1111-1111-111111111111'
const SLOT_ID = '22222222-2222-2222-2222-222222222222'

function makeSlot(overrides: Partial<MealPlanSlotDto> = {}): MealPlanSlotDto {
  return {
    id: SLOT_ID,
    mealPlanId: PLAN_ID,
    recipeId: null,
    label: 'Spaghetti',
    date: '2026-04-20',
    meal: 'Mittag',
    servings: 2,
    sortOrder: 0,
    isCooked: false,
    parentSlotId: null,
    createdAt: '2026-04-20T10:00:00Z',
    updatedAt: '2026-04-20T10:00:00Z',
    ...overrides,
  }
}

beforeEach(() => {
  useAuthStore.setState({
    accessToken: 't',
    user: { id: 'u1', email: 'u1@ex.com', displayName: 'U', role: 'User' },
  })
})

describe('patchSlot', () => {
  it('omits undefined fields from the PATCH body and keeps explicit nulls', async () => {
    let capturedBody: unknown = null
    server.use(
      http.patch(`/api/mealplans/${PLAN_ID}/slots/${SLOT_ID}`, async ({ request }) => {
        capturedBody = await request.json()
        return HttpResponse.json(makeSlot({ servings: 5, label: null }))
      }),
    )

    await patchSlot(PLAN_ID, SLOT_ID, {
      servings: 5,
      label: null,
      // These keys are deliberately undefined and must NOT appear in the body.
      recipeId: undefined,
      isCooked: undefined,
      sortOrder: undefined,
      parentSlotId: undefined,
    })

    expect(capturedBody).toEqual({ servings: 5, label: null })
    // Double-check there is no undefined-ish key leakage (e.g. sortOrder: null).
    const body = capturedBody as Record<string, unknown>
    expect('recipeId' in body).toBe(false)
    expect('isCooked' in body).toBe(false)
    expect('sortOrder' in body).toBe(false)
    expect('parentSlotId' in body).toBe(false)
  })

  it('sends isCooked: true when that is the only field', async () => {
    let capturedBody: unknown = null
    server.use(
      http.patch(`/api/mealplans/${PLAN_ID}/slots/${SLOT_ID}`, async ({ request }) => {
        capturedBody = await request.json()
        return HttpResponse.json(makeSlot({ isCooked: true }))
      }),
    )

    const result = await patchSlot(PLAN_ID, SLOT_ID, { isCooked: true })
    expect(capturedBody).toEqual({ isCooked: true })
    expect(result.isCooked).toBe(true)
  })

  it('URL-encodes the planId and slotId path segments', async () => {
    let capturedUrl: string | null = null
    server.use(
      http.patch(`/api/mealplans/${PLAN_ID}/slots/${SLOT_ID}`, ({ request }) => {
        capturedUrl = new URL(request.url).pathname
        return HttpResponse.json(makeSlot())
      }),
    )

    await patchSlot(PLAN_ID, SLOT_ID, { sortOrder: 10 })
    expect(capturedUrl).toBe(`/api/mealplans/${PLAN_ID}/slots/${SLOT_ID}`)
  })

  it('throws MealPlanApiError with the server error code on 400', async () => {
    server.use(
      http.patch(`/api/mealplans/${PLAN_ID}/slots/${SLOT_ID}`, () =>
        HttpResponse.json(
          { code: 'invalid_input', message: 'Servings müssen 1..50 sein.' },
          { status: 400 },
        ),
      ),
    )

    await expect(
      patchSlot(PLAN_ID, SLOT_ID, { servings: 99 }),
    ).rejects.toThrow(/Servings müssen 1..50 sein/)
  })
})

describe('deleteSlot', () => {
  it('issues a DELETE request and resolves on 204', async () => {
    let capturedMethod: string | null = null
    server.use(
      http.delete(`/api/mealplans/${PLAN_ID}/slots/${SLOT_ID}`, ({ request }) => {
        capturedMethod = request.method
        return new HttpResponse(null, { status: 204 })
      }),
    )

    await expect(deleteSlot(PLAN_ID, SLOT_ID)).resolves.toBeUndefined()
    expect(capturedMethod).toBe('DELETE')
  })

  it('throws MealPlanApiError on 404 not-found', async () => {
    server.use(
      http.delete(`/api/mealplans/${PLAN_ID}/slots/${SLOT_ID}`, () =>
        HttpResponse.json(
          { code: 'slot.not_found', message: 'Slot wurde nicht gefunden.' },
          { status: 404 },
        ),
      ),
    )

    await expect(deleteSlot(PLAN_ID, SLOT_ID)).rejects.toThrow(/nicht gefunden/)
  })
})
