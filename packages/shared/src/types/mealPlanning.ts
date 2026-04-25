/**
 * Meal-planning DTOs mirroring the .NET API contract in
 * `SharedCookbook.Api/Endpoints/MealPlanning/MealPlanEndpoints.cs`
 * (P3-1). Hand-written for now; will be generated from the OpenAPI
 * spec once the tooling lands.
 *
 * Dates come over the wire as ISO YYYY-MM-DD strings (matching
 * .NET's `DateOnly` default JSON serialisation); the frontend can
 * parse them with `new Date(...)` or `dayjs(...)` at the render
 * layer.
 */

/**
 * Time-of-day bucket for a meal plan slot. Keeps the week-grid
 * rendering deterministic; the UI translates the raw identifier to
 * a localised label.
 */
export type MealSlot = 'Frühstück' | 'Mittag' | 'Abend' | 'Snack'

/**
 * A single slot on a weekly meal plan — either a recipe reference
 * or a free-text label (e.g. "Restaurant", "Reste"). `parentSlotId`
 * links meal-prep leftovers back to the cooking slot so the
 * shopping-list aggregator doesn't double-count ingredients.
 */
export interface MealPlanSlotDto {
  id: string
  mealPlanId: string
  recipeId: string | null
  label: string | null
  /** ISO YYYY-MM-DD — must fall within [weekStart, weekStart+6]. */
  date: string
  meal: MealSlot
  /** 1..20 servings. */
  servings: number
  /** Relative ordering within the same day + meal bucket. */
  sortOrder: number
  isCooked: boolean
  parentSlotId: string | null
  createdAt: string
  updatedAt: string
}

/**
 * A weekly meal plan — one row per (groupId, weekStart) pair.
 * `version` increments on every slot change; P3-9 will use it for
 * optimistic concurrency + lightweight history.
 */
export interface MealPlanDto {
  id: string
  groupId: string
  /** ISO YYYY-MM-DD; always a Monday. */
  weekStart: string
  version: number
  createdAt: string
  updatedAt: string
  slots: MealPlanSlotDto[]
}

// ── Request shapes ────────────────────────────────────────────────

export interface CreateMealPlanRequest {
  /** ISO YYYY-MM-DD; must be a Monday. */
  weekStart: string
}

/**
 * Body for `POST /api/mealplans/{planId}/slots`. At least one of
 * `recipeId` or `label` must be present; servings in 1..20.
 */
export interface AddSlotRequest {
  recipeId?: string | null
  label?: string | null
  date: string
  meal: MealSlot
  servings: number
  sortOrder?: number | null
  parentSlotId?: string | null
}

/**
 * PATCH body for `PATCH /api/mealplans/{planId}/slots/{slotId}`.
 * JSON Merge Patch semantics: a field being **absent** means "leave
 * untouched"; a field set to `null` means "clear" (for the nullable
 * columns: `recipeId`, `label`, `parentSlotId`). Integer fields
 * (`servings`, `sortOrder`) and `isCooked` are set when present.
 */
export interface PatchSlotRequest {
  recipeId?: string | null
  label?: string | null
  servings?: number
  sortOrder?: number
  isCooked?: boolean
  parentSlotId?: string | null
}
