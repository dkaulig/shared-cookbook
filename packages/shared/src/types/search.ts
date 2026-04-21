/**
 * Recipe-search DTOs — mirrors .NET API in
 * `FamilienKochbuch.Api/Endpoints/SearchEndpoints.cs`. Hand-written for
 * now; OpenAPI-generated later.
 */

import type { RecipeSummaryDto } from './recipes.ts'

/**
 * SEARCH-1 — sort enum for the cross-group search endpoint
 * (`GET /api/recipes/search`). Mirrors SEARCH-0's backend enum. The
 * `relevance_desc` value is the default when `q` is set and has no
 * meaning without a query term (the backend 400s empty `q` before
 * sort is evaluated). `cook_count_desc` is deliberately omitted —
 * PAGE-0 cut it on the list endpoint and the global-search slice
 * keeps the cut.
 */
export type GlobalSearchSort =
  | 'relevance_desc'
  | 'updated_desc'
  | 'cooked_desc'
  | 'title_asc'
  | 'rating_desc'

export const DEFAULT_GLOBAL_SEARCH_SORT: GlobalSearchSort = 'relevance_desc'
export const DEFAULT_GLOBAL_SEARCH_PAGE_SIZE = 24

/**
 * Frontend-visible sort enum for the recipe list/search endpoints.
 *
 * The older `newest` / `best_rated` / `last_cooked` values are kept for
 * backward-compat with the search endpoint (`/api/groups/:id/recipes/search`)
 * while the newer PAGE-0/1 values (`updated_desc`, `cooked_desc`,
 * `title_asc`, `cook_count_desc`, `rating_desc`) belong to the paginated
 * list endpoint (`/api/groups/:id/recipes`). One of `cook_count_desc` /
 * `rating_desc` may be cut server-side depending on column availability;
 * the UI ships all five optimistically and surfaces unsupported picks as
 * a 400 `invalid_sort` via the standard list-load-error toast.
 */
export type SearchSort =
  | 'newest'
  | 'best_rated'
  | 'last_cooked'
  | 'updated_desc'
  | 'cooked_desc'
  | 'title_asc'
  | 'cook_count_desc'
  | 'rating_desc'

export interface RecipeSearchParams {
  q?: string
  tags?: string[]
  minRating?: number
  maxPrepTime?: number
  createdBy?: string
  sort?: SearchSort
  page?: number
  pageSize?: number
}

export interface SearchResult<T> {
  items: T[]
  page: number
  pageSize: number
  total: number
}

export type RecipeSearchResult = SearchResult<RecipeSummaryDto>

export interface RandomRecipeResponse {
  recipeId: string | null
}

/**
 * SEARCH-1 — a single result item in the cross-group search response.
 * Extends `RecipeSummaryDto` with the owning group's display name so
 * the UI can render a group-chip on each card without a second fetch.
 * `groupId` is already on `RecipeSummaryDto`.
 */
export interface RecipeGlobalSearchItem extends RecipeSummaryDto {
  groupName: string
}

/**
 * SEARCH-1 — query parameters for the cross-group search hook /
 * endpoint. `q` is required (empty / < 1 char is rejected with
 * `invalid_query` 400 by the backend). `page` / `pageSize` / `sort`
 * mirror the PAGE-0 list endpoint conventions.
 */
export interface RecipeGlobalSearchParams {
  q: string
  page?: number
  pageSize?: number
  sort?: GlobalSearchSort
}

/**
 * SEARCH-1 — cross-group search response envelope. Same shape as the
 * PAGE-1 paginated list (`hasNextPage` / `hasPrevPage`) but with the
 * echoed `query` string and group-aware items.
 */
export interface RecipeGlobalSearchResult {
  items: RecipeGlobalSearchItem[]
  page: number
  pageSize: number
  total: number
  hasNextPage: boolean
  hasPrevPage: boolean
  query: string
}
