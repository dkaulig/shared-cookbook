import type { RecipeSearchParams, SearchSort } from '@familien-kochbuch/shared'

/**
 * Bidirectional mapping between filter state and URL search params.
 * Keeping the two transforms side-by-side guarantees a round-trip:
 * write(read(p)) == p for any valid URL.
 */

export function readFiltersFromSearchParams(params: URLSearchParams): RecipeSearchParams {
  const out: RecipeSearchParams = {}
  const q = params.get('q')
  if (q && q.trim().length > 0) out.q = q
  const tags = params.get('tags')
  if (tags && tags.trim().length > 0) {
    out.tags = tags.split(',').map((p) => p.trim()).filter((p) => p.length > 0)
  }
  const minRating = params.get('minRating')
  if (minRating) {
    const n = Number(minRating)
    if (!Number.isNaN(n)) out.minRating = n
  }
  const maxPrepTime = params.get('maxPrepTime')
  if (maxPrepTime) {
    const n = Number(maxPrepTime)
    if (!Number.isNaN(n)) out.maxPrepTime = n
  }
  const createdBy = params.get('createdBy')
  if (createdBy) out.createdBy = createdBy
  const sort = params.get('sort')
  if (
    sort === 'newest' ||
    sort === 'best_rated' ||
    sort === 'last_cooked' ||
    sort === 'updated_desc' ||
    sort === 'cooked_desc' ||
    sort === 'title_asc' ||
    sort === 'cook_count_desc' ||
    sort === 'rating_desc'
  ) {
    out.sort = sort as SearchSort
  }
  const page = params.get('page')
  if (page) {
    const n = Number(page)
    if (!Number.isNaN(n)) out.page = n
  }
  const pageSize = params.get('pageSize')
  if (pageSize) {
    const n = Number(pageSize)
    if (!Number.isNaN(n)) out.pageSize = n
  }
  return out
}

export function writeFiltersToSearchParams(filters: RecipeSearchParams): URLSearchParams {
  const params = new URLSearchParams()
  if (filters.q && filters.q.trim().length > 0) params.set('q', filters.q)
  if (filters.tags && filters.tags.length > 0) params.set('tags', filters.tags.join(','))
  if (filters.minRating != null) params.set('minRating', String(filters.minRating))
  if (filters.maxPrepTime != null) params.set('maxPrepTime', String(filters.maxPrepTime))
  if (filters.createdBy) params.set('createdBy', filters.createdBy)
  if (filters.sort) params.set('sort', filters.sort)
  if (filters.page != null) params.set('page', String(filters.page))
  if (filters.pageSize != null) params.set('pageSize', String(filters.pageSize))
  return params
}
