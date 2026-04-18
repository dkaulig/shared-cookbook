/**
 * Recipe-search DTOs — mirrors .NET API in
 * `FamilienKochbuch.Api/Endpoints/SearchEndpoints.cs`. Hand-written for
 * now; OpenAPI-generated later.
 */

import type { RecipeSummaryDto } from './recipes.ts'

export type SearchSort = 'newest' | 'best_rated' | 'last_cooked'

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
