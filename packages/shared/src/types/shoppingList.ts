/**
 * Shopping-list DTOs mirroring the .NET API contract in
 * `FamilienKochbuch.Api/Endpoints/MealPlanning/ShoppingListEndpoints.cs`
 * (P3-5). Hand-written for now; will be generated from the OpenAPI
 * spec once the tooling lands.
 *
 * Dates/timestamps come over the wire as ISO strings (DateOnly →
 * `YYYY-MM-DD`, DateTimeOffset → `YYYY-MM-DDTHH:mm:ss[.fff]Z`) per
 * .NET's default JSON serialisation. The frontend parses them at the
 * render layer.
 */

/**
 * Supermarket aisle bucket. Mirrors the .NET
 * `FamilienKochbuch.Domain.Enums.IngredientCategory` enum — string
 * literals because the API serialises enums by name. P3-6 expanded the
 * union from the initial `Sonstiges`-only fallback to the full ten-
 * category supermarket layout (Obst/Gemüse, Trockenwaren, Gewürze,
 * Molkerei, Fleisch/Fisch, Backen/Süßes, Konserven/Fertig, Getränke/
 * Öle, Tiefkühl/Brot, Haushalt).
 */
export type IngredientCategory =
  | 'Sonstiges'
  | 'ObstGemuese'
  | 'Trockenwaren'
  | 'Gewuerze'
  | 'Molkerei'
  | 'FleischFisch'
  | 'BackenSuess'
  | 'KonservenFertig'
  | 'GetraenkeOele'
  | 'TiefkuehlBrot'
  | 'Haushalt'

/**
 * Where a shopping-list item originated:
 *   - `FromPlan`: auto-aggregated from a recipe on a MealPlanSlot.
 *   - `Manual`: the user typed it in (week-specific, never carried over).
 *   - `CarriedOver`: the generator pulled it from the previous week's
 *     unchecked items; see plan §Carryover.
 */
export type ShoppingListItemSource = 'FromPlan' | 'Manual' | 'CarriedOver'

/**
 * A single line on a shopping list. Quantity + Unit are free-text
 * strings (no unit conversion); the generator sums numeric quantities
 * when they are parseable as decimals, otherwise it keeps the first
 * occurrence and appends a note.
 */
export interface ShoppingListItemDto {
  id: string
  shoppingListId: string
  name: string
  quantity: string | null
  unit: string | null
  note: string | null
  isChecked: boolean
  category: IngredientCategory
  source: ShoppingListItemSource
  /** Relative ordering within the same category bucket. */
  sortOrder: number
  /** UI shows a ↺ badge when true. */
  carriedOverFromPreviousWeek: boolean
  createdAt: string
  updatedAt: string
}

/**
 * 1:1 with MealPlan. One row per plan, created/updated on generate,
 * regenerate, and item mutations. `lastGeneratedAt` drives the
 * carryover-merge decision (carryover only on first generate).
 */
export interface ShoppingListDto {
  id: string
  mealPlanId: string
  createdAt: string
  updatedAt: string
  lastGeneratedAt: string
  items: ShoppingListItemDto[]
}

// ── Request shapes ────────────────────────────────────────────────

/**
 * Body for `POST /api/shopping-lists/{listId}/items`. Always creates
 * a `Manual` item (the server pins the source). `category` defaults
 * to `Sonstiges` when omitted.
 */
export interface AddShoppingListItemRequest {
  name: string
  quantity?: string | null
  unit?: string | null
  note?: string | null
  category?: IngredientCategory | null
}

/**
 * PATCH body for `PATCH /api/shopping-lists/{id}/items/{itemId}`.
 * JSON Merge Patch semantics — only `isChecked` + `note` are mutable
 * via PATCH; other fields are immutable to preserve the aggregator's
 * merge-by-key invariants.
 */
export interface PatchShoppingListItemRequest {
  isChecked?: boolean
  /** `null` clears the note, a string sets it. */
  note?: string | null
}
