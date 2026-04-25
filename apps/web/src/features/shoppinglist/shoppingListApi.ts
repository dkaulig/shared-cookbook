import type {
  AddShoppingListItemRequest,
  ApiError,
  PatchShoppingListItemRequest,
  ShoppingListDto,
  ShoppingListItemDto,
  VersionMismatchError as VersionMismatchErrorBody,
} from '@shared-cookbook/shared'
import { apiClient } from '@/features/auth/apiClient'
import { ApiErrorBase, VersionMismatchError } from '@/features/_shared/apiError'
import { stripUndefined } from '@/features/_shared/mergePatch'

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
export class ShoppingListApiError extends ApiErrorBase {
  override readonly name = 'ShoppingListApiError'
}

async function request<T>(
  input: RequestInfo | URL,
  init?: import('@/features/auth/apiClient').ApiClientInit,
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
  // OFF4 — 409 version_mismatch surfaces as a typed VersionMismatchError
  // so the conflict resolver hook can narrow via `instanceof`. All
  // other failures keep the existing ShoppingListApiError path.
  if (response.status === 409 && code === 'version_mismatch') {
    const body = payload as unknown as VersionMismatchErrorBody | null
    throw new VersionMismatchError(message, body?.current ?? null)
  }
  // REL-4: forward fieldName when present so form call-sites can
  // attribute validation failures to a specific input.
  throw new ShoppingListApiError(code, message, response.status, payload?.fieldName)
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

export async function patchShoppingListItem(
  listId: string,
  itemId: string,
  patch: PatchShoppingListItemRequest,
  options?: { ifMatch?: string },
): Promise<ShoppingListItemDto> {
  return request<ShoppingListItemDto>(
    `/api/shopping-lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(stripUndefined(patch)),
      ifMatch: options?.ifMatch,
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
