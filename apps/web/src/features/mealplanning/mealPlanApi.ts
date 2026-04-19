import type {
  AddSlotRequest,
  ApiError,
  CreateMealPlanRequest,
  MealPlanDto,
  MealPlanSlotDto,
  PatchSlotRequest,
} from '@familien-kochbuch/shared'
import { apiClient } from '@/features/auth/apiClient'

/**
 * Typed access layer for the P3-1 meal-planning endpoints. Mirrors the
 * ratingsApi / recipesApi convention: every call goes through `apiClient`
 * (so Bearer-token injection + silent refresh on 401 work), and every
 * failure surfaces a throwable `MealPlanApiError` so the UI can
 * distinguish "plan does not exist yet" (404 → `code: "mealplan.not_found"`)
 * from a genuine load error — without having to double-cast the caught
 * value at every call site.
 */

/**
 * Named Error subclass with typed `code` / `message` / `status`. Using a
 * real class (instead of an ad-hoc `Error & ApiError & { status }`
 * intersection) lets consumers narrow via `instanceof` and drops the
 * `as unknown as` double-cast previously needed in useMealPlan.
 */
export class MealPlanApiError extends Error implements ApiError {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(`${code}: ${message}`)
    this.name = 'MealPlanApiError'
    this.code = code
    this.status = status
    // `Error` constructor ignores our explicit `message` assignment on
    // some engines when subclassed — pin it for predictable UI copy.
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
    /* non-JSON body — fall through */
  }
  const code = payload?.code ?? `http_${response.status}`
  const message = payload?.message ?? response.statusText
  throw new MealPlanApiError(code, message, response.status)
}

export async function fetchMealPlan(
  groupId: string,
  weekStart: string,
): Promise<MealPlanDto> {
  return request<MealPlanDto>(
    `/api/groups/${encodeURIComponent(groupId)}/mealplans/${encodeURIComponent(weekStart)}`,
  )
}

export async function createMealPlan(
  groupId: string,
  body: CreateMealPlanRequest,
): Promise<MealPlanDto> {
  return request<MealPlanDto>(
    `/api/groups/${encodeURIComponent(groupId)}/mealplans`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  )
}

export async function addSlot(
  planId: string,
  body: AddSlotRequest,
): Promise<MealPlanSlotDto> {
  return request<MealPlanSlotDto>(
    `/api/mealplans/${encodeURIComponent(planId)}/slots`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  )
}

/**
 * Strips keys whose value is `undefined` so the JSON body we ship
 * faithfully represents a JSON Merge Patch — "absent" keys mean
 * "leave untouched" on the server (see `SlotPatchRequest.ReadAsync`
 * in `MealPlanEndpoints.cs`). A `null` value stays in the body and
 * signals "clear this field" for the nullable columns (`recipeId`,
 * `label`, `parentSlotId`).
 */
function stripUndefined(patch: PatchSlotRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  for (const key of Object.keys(patch) as Array<keyof PatchSlotRequest>) {
    const value = patch[key]
    if (value !== undefined) {
      body[key] = value
    }
  }
  return body
}

export async function patchSlot(
  planId: string,
  slotId: string,
  patch: PatchSlotRequest,
): Promise<MealPlanSlotDto> {
  return request<MealPlanSlotDto>(
    `/api/mealplans/${encodeURIComponent(planId)}/slots/${encodeURIComponent(slotId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(stripUndefined(patch)),
    },
  )
}

export async function deleteSlot(planId: string, slotId: string): Promise<void> {
  await request<void>(
    `/api/mealplans/${encodeURIComponent(planId)}/slots/${encodeURIComponent(slotId)}`,
    { method: 'DELETE' },
    undefined,
  )
}
