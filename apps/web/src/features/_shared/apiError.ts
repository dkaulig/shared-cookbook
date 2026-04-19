import type { ApiError } from '@familien-kochbuch/shared'

/**
 * Common ground for feature-scoped typed `Error` subclasses (e.g.
 * `MealPlanApiError`, `ShoppingListApiError`). Centralises the engine-
 * quirk workaround where the base `Error` constructor ignores the
 * `message` we want to surface — we pin it here so every subclass
 * renders predictable UI copy without duplicating the fix.
 *
 * Subclasses override only `name` (used in debugger stack traces and
 * downstream `instanceof` narrowing) and keep the `code` / `status`
 * contract from `ApiError` so callers can branch on either.
 */
export abstract class ApiErrorBase extends Error implements ApiError {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(`${code}: ${message}`)
    this.code = code
    this.status = status
    // Pin the message explicitly — the `Error` constructor silently
    // drops it on some engines when subclassed.
    this.message = message
  }
}
