import { beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import type { ShoppingListItemDto } from '@shared-cookbook/shared'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import {
  ShoppingListApiError,
  addShoppingListItem,
  deleteShoppingListItem,
  patchShoppingListItem,
} from './shoppingListApi'

const LIST_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const ITEM_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

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

beforeEach(() => {
  useAuthStore.setState({
    accessToken: 't',
    user: { id: 'u1', email: 'u1@ex.com', displayName: 'U', role: 'User' },
  })
})

describe('patchShoppingListItem', () => {
  it('strips undefined keys and keeps explicit nulls in the PATCH body', async () => {
    let captured: unknown = null
    server.use(
      http.patch(
        `/api/shopping-lists/${LIST_ID}/items/${ITEM_ID}`,
        async ({ request }) => {
          captured = await request.json()
          return HttpResponse.json(makeItem({ isChecked: true, note: null }))
        },
      ),
    )

    await patchShoppingListItem(LIST_ID, ITEM_ID, {
      isChecked: true,
      note: null,
    })

    expect(captured).toEqual({ isChecked: true, note: null })
  })

  it('omits `note` entirely when it is explicitly undefined', async () => {
    let captured: unknown = null
    server.use(
      http.patch(
        `/api/shopping-lists/${LIST_ID}/items/${ITEM_ID}`,
        async ({ request }) => {
          captured = await request.json()
          return HttpResponse.json(makeItem({ isChecked: true }))
        },
      ),
    )

    await patchShoppingListItem(LIST_ID, ITEM_ID, {
      isChecked: true,
      note: undefined,
    })

    const body = captured as Record<string, unknown>
    expect(body).toEqual({ isChecked: true })
    expect('note' in body).toBe(false)
  })

  it('URL-encodes the listId and itemId path segments', async () => {
    let capturedUrl: string | null = null
    server.use(
      http.patch(
        `/api/shopping-lists/${LIST_ID}/items/${ITEM_ID}`,
        ({ request }) => {
          capturedUrl = new URL(request.url).pathname
          return HttpResponse.json(makeItem({ isChecked: true }))
        },
      ),
    )

    await patchShoppingListItem(LIST_ID, ITEM_ID, { isChecked: true })
    expect(capturedUrl).toBe(`/api/shopping-lists/${LIST_ID}/items/${ITEM_ID}`)
  })

  it('throws ShoppingListApiError with the server code + message on 404', async () => {
    server.use(
      http.patch(
        `/api/shopping-lists/${LIST_ID}/items/${ITEM_ID}`,
        () =>
          HttpResponse.json(
            { code: 'shopping_list_item.not_found', message: 'Eintrag nicht gefunden.' },
            { status: 404 },
          ),
      ),
    )

    await expect(
      patchShoppingListItem(LIST_ID, ITEM_ID, { isChecked: true }),
    ).rejects.toBeInstanceOf(ShoppingListApiError)
  })
})

describe('addShoppingListItem', () => {
  it('POSTs a body with only the provided keys', async () => {
    let captured: unknown = null
    server.use(
      http.post(
        `/api/shopping-lists/${LIST_ID}/items`,
        async ({ request }) => {
          captured = await request.json()
          return HttpResponse.json(
            makeItem({ name: 'Chili', source: 'Manual' }),
            { status: 201 },
          )
        },
      ),
    )

    await addShoppingListItem(LIST_ID, {
      name: 'Chili',
      quantity: '2',
      unit: 'Stk',
      // `note` + `category` left undefined — must not appear in the body.
    })

    expect(captured).toEqual({ name: 'Chili', quantity: '2', unit: 'Stk' })
  })
})

describe('deleteShoppingListItem', () => {
  it('issues a DELETE and resolves on 204', async () => {
    let capturedMethod: string | null = null
    server.use(
      http.delete(
        `/api/shopping-lists/${LIST_ID}/items/${ITEM_ID}`,
        ({ request }) => {
          capturedMethod = request.method
          return new HttpResponse(null, { status: 204 })
        },
      ),
    )

    await expect(
      deleteShoppingListItem(LIST_ID, ITEM_ID),
    ).resolves.toBeUndefined()
    expect(capturedMethod).toBe('DELETE')
  })
})
