import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type {
  ShoppingListDto,
  ShoppingListItemDto,
} from '@familien-kochbuch/shared'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import {
  shoppingListQueryKeys,
  usePatchShoppingListItem,
} from './useShoppingList'

const PLAN_ID = '11111111-1111-1111-1111-111111111111'
const LIST_ID = '22222222-2222-2222-2222-222222222222'
const ITEM_ID = '33333333-3333-3333-3333-333333333333'

function makeItem(
  overrides: Partial<ShoppingListItemDto> = {},
): ShoppingListItemDto {
  return {
    id: ITEM_ID,
    shoppingListId: LIST_ID,
    name: 'Tomate',
    quantity: '500',
    unit: 'g',
    note: null,
    isChecked: false,
    category: 'ObstGemuese',
    source: 'FromPlan',
    sortOrder: 0,
    carriedOverFromPreviousWeek: false,
    createdAt: '2026-04-19T00:00:00Z',
    updatedAt: '2026-04-19T00:00:00Z',
    ...overrides,
  }
}

function makeList(items: ShoppingListItemDto[]): ShoppingListDto {
  return {
    id: LIST_ID,
    mealPlanId: PLAN_ID,
    createdAt: '2026-04-19T00:00:00Z',
    updatedAt: '2026-04-19T00:00:00Z',
    lastGeneratedAt: '2026-04-19T00:00:00Z',
    items,
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

describe('usePatchShoppingListItem', () => {
  it('applies the optimistic check-off splice before the network resolves', async () => {
    let resolveServer: (() => void) | null = null
    const block = new Promise<void>((resolve) => {
      resolveServer = resolve
    })
    server.use(
      http.patch(
        `/api/shopping-lists/${LIST_ID}/items/${ITEM_ID}`,
        async () => {
          await block
          return HttpResponse.json(makeItem({ isChecked: true }))
        },
      ),
    )

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    client.setQueryData(
      shoppingListQueryKeys.forPlan(PLAN_ID),
      makeList([makeItem({ isChecked: false })]),
    )

    const { result } = renderHook(
      () => usePatchShoppingListItem(PLAN_ID, LIST_ID),
      { wrapper: withClient(client) },
    )

    result.current.mutate({ itemId: ITEM_ID, patch: { isChecked: true } })

    // Cache flips to checked *before* the server responds — proves the
    // onMutate optimistic splice is wired up.
    await waitFor(() => {
      const cached = client.getQueryData<ShoppingListDto>(
        shoppingListQueryKeys.forPlan(PLAN_ID),
      )
      expect(cached?.items[0]?.isChecked).toBe(true)
    })

    resolveServer?.()
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
  })

  it('rolls the cache back to the pre-mutation snapshot on server error', async () => {
    server.use(
      http.patch(
        `/api/shopping-lists/${LIST_ID}/items/${ITEM_ID}`,
        () =>
          HttpResponse.json(
            { code: 'internal', message: 'Boom' },
            { status: 500 },
          ),
      ),
    )

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    client.setQueryData(
      shoppingListQueryKeys.forPlan(PLAN_ID),
      makeList([makeItem({ isChecked: false })]),
    )

    const { result } = renderHook(
      () => usePatchShoppingListItem(PLAN_ID, LIST_ID),
      { wrapper: withClient(client) },
    )

    result.current.mutate({ itemId: ITEM_ID, patch: { isChecked: true } })
    await waitFor(() => expect(result.current.isError).toBe(true))

    const cached = client.getQueryData<ShoppingListDto>(
      shoppingListQueryKeys.forPlan(PLAN_ID),
    )
    // Optimistic flip rolled back — item is still unchecked.
    expect(cached?.items[0]?.isChecked).toBe(false)
  })

  it('invalidates the per-plan query key after the mutation settles', async () => {
    server.use(
      http.patch(
        `/api/shopping-lists/${LIST_ID}/items/${ITEM_ID}`,
        () => HttpResponse.json(makeItem({ isChecked: true })),
      ),
    )

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    client.setQueryData(
      shoppingListQueryKeys.forPlan(PLAN_ID),
      makeList([makeItem()]),
    )

    const { result } = renderHook(
      () => usePatchShoppingListItem(PLAN_ID, LIST_ID),
      { wrapper: withClient(client) },
    )

    result.current.mutate({ itemId: ITEM_ID, patch: { isChecked: true } })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    const state = client.getQueryState(shoppingListQueryKeys.forPlan(PLAN_ID))
    expect(state?.isInvalidated).toBe(true)
  })
})
