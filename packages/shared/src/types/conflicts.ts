/**
 * OFF3 (Phase 5) wire shape for `409 Conflict` responses returned by
 * mutation endpoints when the client's `If-Match` header doesn't line
 * up with the server's current `Version`. Mirrors the C# helper
 * `FamilienResults.Conflict(code, message, current)` in
 * `apps/api/src/SharedCookbook.Api/Services/FamilienResults.cs`.
 *
 * The `current` field carries the full server-authoritative DTO at the
 * moment the conflict was detected — the frontend can hydrate its
 * local cache without a follow-up GET. Consumers narrow the `unknown`
 * payload to the resource-specific DTO (e.g. `MealPlanDto`,
 * `RecipeDetailDto`, `ShoppingListDto`, `GroupSummaryDto`) at the call
 * site.
 */
export interface VersionMismatchError {
  /** Machine-readable discriminator; always the literal below. */
  code: 'version_mismatch'
  /** Human-readable German message safe for display. */
  message: string
  /**
   * Server's current state at the time of the conflict. Shape matches
   * a normal GET of the mutated resource. `undefined` only when the
   * endpoint deliberately suppresses it (none of the OFF3 mutation
   * endpoints do — kept loose so future endpoints can opt out).
   */
  current: unknown
}
