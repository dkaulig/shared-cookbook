/**
 * Recipe-search DTOs — mirrors .NET API in
 * `FamilienKochbuch.Api/Endpoints/SearchEndpoints.cs`. Hand-written for
 * now; OpenAPI-generated later.
 */

import type { RecipeSummaryDto } from './recipes.ts'

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
