/**
 * JSON Merge Patch helpers shared between the mealplanning and shopping-
 * list API layers. "Absent" keys mean "leave untouched" on the server
 * (RFC 7396 / `SlotPatchRequest.ReadAsync` in `MealPlanEndpoints.cs`,
 * and the analogous shopping-list reader). A `null` value stays in the
 * body and clears the field server-side for nullable columns.
 *
 * Extracted from feature-local duplicates in `mealPlanApi.ts` and
 * `shoppingListApi.ts` so both code paths share one canonical impl.
 */

/**
 * Strips keys whose value is `undefined` so the JSON body we ship
 * faithfully represents a JSON Merge Patch. Returns a fresh plain
 * object with the same key type — `Partial<T>` — because the input
 * may legitimately carry keys that the caller omitted at the type
 * level (e.g. builder-style requests where optional fields default
 * to `undefined`).
 */
export function stripUndefined<T extends object>(obj: T): Partial<T> {
  const body: Partial<T> = {}
  const source = obj as Readonly<Record<string, unknown>>
  for (const key of Object.keys(source)) {
    const value = source[key]
    if (value !== undefined) {
      ;(body as Record<string, unknown>)[key] = value
    }
  }
  return body
}
