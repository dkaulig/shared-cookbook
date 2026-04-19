import type {
  AddShoppingListItemRequest,
  ApiError,
  PatchShoppingListItemRequest,
  ShoppingListDto,
  ShoppingListItemDto,
} from '@familien-kochbuch/shared'
import { apiClient } from '@/features/auth/apiClient'

/**
 * Typed API layer for the P3-5 shopping-list endpoints. Mirrors the
 * mealPlanApi convention: every call routes through `apiClient` (Bearer
 * token + silent refresh on 401) and every failure becomes a throwable
 * `ShoppingListApiError` so callers can narrow via `instanceof`.
 *
 * Routes (see `ShoppingListEndpoints.cs`):
 *   GET    /api/mealplans/{planId}/shopping-list
 *   POST   /api/mealplans/{planId}/shopping-list/generate
 *   POST   /api/shopping-lists/{listId}/items
 *   PATCH  /api/shopping-lists/{listId}/items/{itemId}
 *   DELETE /api/shopping-lists/{listId}/items/{itemId}
 */
export class ShoppingListApiError extends Error implements ApiError {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(`${code}: ${message}`)
    this.name = 'ShoppingListApiError'
    this.code = code
    this.status = status
    // The Error constructor drops our explicit message in some engines
    // when subclassed — pin it for predictable UI copy.
    this.message = message
  }
}

async function request<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
  emptyResult?: T,
): Promise<T> {
  const response = await apiClient(input, init)
  if (!response.ok) {
    await throwApiError(response)
  }
  if (response.status === 204 || response.headers.get('Content-Length') === '0') {
    return (emptyResult as T) ?? (undefined as unknown as T)
  }
  return (await response.json()) as T
}

async function throwApiError(response: Response): Promise<never> {
  let payload: ApiError | null = null
  try {
    payload = (await response.json()) as ApiError
  } catch {
    /* non-JSON body — fall through to the HTTP-status fallback */
  }
  const code = payload?.code ?? `http_${response.status}`
  const message = payload?.message ?? response.statusText
  throw new ShoppingListApiError(code, message, response.status)
}

export async function fetchShoppingList(planId: string): Promise<ShoppingListDto> {
  return request<ShoppingListDto>(
    `/api/mealplans/${encodeURIComponent(planId)}/shopping-list`,
  )
}

/**
 * Triggers the backend aggregator. The server returns `201 Created`
 * with the full persisted list on first generate and `200 OK` on
 * subsequent regenerates — both map to `ShoppingListDto` in the body.
 */
export async function generateShoppingList(
  planId: string,
): Promise<ShoppingListDto> {
  return request<ShoppingListDto>(
    `/api/mealplans/${encodeURIComponent(planId)}/shopping-list/generate`,
    { method: 'POST' },
  )
}

export async function addShoppingListItem(
  listId: string,
  body: AddShoppingListItemRequest,
): Promise<ShoppingListItemDto> {
  return request<ShoppingListItemDto>(
    `/api/shopping-lists/${encodeURIComponent(listId)}/items`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(stripUndefined(body)),
    },
  )
}

/**
 * Strips keys whose value is `undefined` so the JSON body we ship is a
 * faithful JSON Merge Patch — "absent" keys mean "leave untouched" on
 * the server, `null` stays and clears the field. Kept as a local helper
 * (not shared with mealPlanApi) because the PatchShoppingListItemRequest
 * keyset is smaller and this way typing stays tight.
 *
 * We accept DTOs whose declared shape is more structured than
 * `Record<string, unknown>` (e.g. `AddShoppingListItemRequest`) — the
 * structural-cast through `Readonly<Record<string, unknown>>` is safe
 * at runtime because `Object.keys` + property access only need the
 * object to have string keys, which every plain DTO satisfies.
 */
function stripUndefined(patch: object): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  const source = patch as Readonly<Record<string, unknown>>
  for (const key of Object.keys(source)) {
    const value = source[key]
    if (value !== undefined) {
      body[key] = value
    }
  }
  return body
}

export async function patchShoppingListItem(
  listId: string,
  itemId: string,
  patch: PatchShoppingListItemRequest,
): Promise<ShoppingListItemDto> {
  return request<ShoppingListItemDto>(
    `/api/shopping-lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(stripUndefined(patch)),
    },
  )
}

export async function deleteShoppingListItem(
  listId: string,
  itemId: string,
): Promise<void> {
  await request<void>(
    `/api/shopping-lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}`,
    { method: 'DELETE' },
    undefined,
  )
}
