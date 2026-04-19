import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { MealPlanDto, MealPlanSlotDto } from '@familien-kochbuch/shared'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import {
  mealPlanQueryKeys,
  useDeleteSlot,
  usePatchSlot,
} from './useMealPlan'

const GROUP_ID = 'g1'
const WEEK_START = '2026-04-20'
const PLAN_ID = '11111111-1111-1111-1111-111111111111'
const SLOT_ID = '22222222-2222-2222-2222-222222222222'

function makeSlot(overrides: Partial<MealPlanSlotDto> = {}): MealPlanSlotDto {
  return {
    id: SLOT_ID,
    mealPlanId: PLAN_ID,
    recipeId: null,
    label: 'Spaghetti',
    date: WEEK_START,
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

function makePlan(slots: MealPlanSlotDto[]): MealPlanDto {
  return {
    id: PLAN_ID,
    groupId: GROUP_ID,
    weekStart: WEEK_START,
    version: 1,
    createdAt: '2026-04-20T00:00:00Z',
    updatedAt: '2026-04-20T00:00:00Z',
    slots,
  }
}

function withClient(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

beforeEach(() => {
  useAuthStore.setState({
    accessToken: 't',
    user: { id: 'u1', email: 'u1@ex.com', displayName: 'U', role: 'User' },
  })
})

describe('usePatchSlot', () => {
  it('splices the updated slot into the cached plan on success', async () => {
    server.use(
      http.patch(`/api/mealplans/${PLAN_ID}/slots/${SLOT_ID}`, () =>
        HttpResponse.json(makeSlot({ servings: 5 })),
      ),
    )

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    client.setQueryData(
      mealPlanQueryKeys.forWeek(GROUP_ID, WEEK_START),
      makePlan([makeSlot({ servings: 2 })]),
    )

    const { result } = renderHook(
      () => usePatchSlot(GROUP_ID, WEEK_START, PLAN_ID),
      { wrapper: withClient(client) },
    )

    result.current.mutate({ slotId: SLOT_ID, patch: { servings: 5 } })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    const cached = client.getQueryData<MealPlanDto>(
      mealPlanQueryKeys.forWeek(GROUP_ID, WEEK_START),
    )
    expect(cached?.slots[0]?.servings).toBe(5)
  })

  it('invalidates the week-scoped query key on success', async () => {
    server.use(
      http.patch(`/api/mealplans/${PLAN_ID}/slots/${SLOT_ID}`, () =>
        HttpResponse.json(makeSlot({ isCooked: true })),
      ),
    )

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    client.setQueryData(
      mealPlanQueryKeys.forWeek(GROUP_ID, WEEK_START),
      makePlan([makeSlot()]),
    )

    const { result } = renderHook(
      () => usePatchSlot(GROUP_ID, WEEK_START, PLAN_ID),
      { wrapper: withClient(client) },
    )

    result.current.mutate({ slotId: SLOT_ID, patch: { isCooked: true } })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    const state = client.getQueryState(
      mealPlanQueryKeys.forWeek(GROUP_ID, WEEK_START),
    )
    expect(state?.isInvalidated).toBe(true)
  })
})

describe('useDeleteSlot', () => {
  it('removes the slot from the cached plan on success', async () => {
    server.use(
      http.delete(
        `/api/mealplans/${PLAN_ID}/slots/${SLOT_ID}`,
        () => new HttpResponse(null, { status: 204 }),
      ),
    )

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const otherId = '33333333-3333-3333-3333-333333333333'
    client.setQueryData(
      mealPlanQueryKeys.forWeek(GROUP_ID, WEEK_START),
      makePlan([makeSlot(), makeSlot({ id: otherId })]),
    )

    const { result } = renderHook(
      () => useDeleteSlot(GROUP_ID, WEEK_START, PLAN_ID),
      { wrapper: withClient(client) },
    )

    result.current.mutate({ slotId: SLOT_ID })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    const cached = client.getQueryData<MealPlanDto>(
      mealPlanQueryKeys.forWeek(GROUP_ID, WEEK_START),
    )
    expect(cached?.slots.map((s) => s.id)).toEqual([otherId])
  })

  it('invalidates the week-scoped query key on success', async () => {
    server.use(
      http.delete(
        `/api/mealplans/${PLAN_ID}/slots/${SLOT_ID}`,
        () => new HttpResponse(null, { status: 204 }),
      ),
    )

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    client.setQueryData(
      mealPlanQueryKeys.forWeek(GROUP_ID, WEEK_START),
      makePlan([makeSlot()]),
    )

    const { result } = renderHook(
      () => useDeleteSlot(GROUP_ID, WEEK_START, PLAN_ID),
      { wrapper: withClient(client) },
    )

    result.current.mutate({ slotId: SLOT_ID })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    const state = client.getQueryState(
      mealPlanQueryKeys.forWeek(GROUP_ID, WEEK_START),
    )
    expect(state?.isInvalidated).toBe(true)
  })
})
