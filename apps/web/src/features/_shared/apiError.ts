import type {
  ApiError,
  VersionMismatchError as VersionMismatchErrorBody,
} from '@familien-kochbuch/shared'

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

/**
 * OFF4 — concrete `Error` subclass wrapping a 409 `VersionMismatchError`
 * body (see `packages/shared/src/types/conflicts.ts`).
 *
 * The shared 409 wire shape is declarative-only (a plain interface); we
 * attach it to a throwable class here so the feature-scoped API layers
 * (`recipesApi`, `mealPlanApi`, `shoppingListApi`) can re-throw it and
 * the `useConflictResolver` hook can narrow via `instanceof` without
 * sniffing `status === 409 && code === 'version_mismatch'` at every
 * call site.
 *
 * `current` is typed loose (`unknown`) to stay faithful to the wire
 * contract — resource-scoped resolvers narrow it at render time via a
 * user-defined type predicate or the DTO shape the server just sent.
 */
export class VersionMismatchError extends Error implements VersionMismatchErrorBody {
  override readonly name = 'VersionMismatchError'
  readonly code = 'version_mismatch' as const
  readonly status = 409 as const
  readonly current: unknown

  constructor(message: string, current: unknown) {
    super(message)
    // Pin the message for engines that drop it on subclass (see
    // ApiErrorBase for the same workaround).
    this.message = message
    this.current = current
  }
}
