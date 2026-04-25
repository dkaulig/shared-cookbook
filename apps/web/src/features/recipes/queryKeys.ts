import {
  DEFAULT_RECIPE_LIST_PAGE_SIZE,
  type RecipeListSort,
} from '@shared-cookbook/shared'

/**
 * Centralised TanStack Query cache keys for the recipes feature. Keeping
 * them here ensures mutation hooks invalidate the exact same keys that
 * query hooks read.
 *
 * PAGE-1 — `forGroup` now folds the paginated list contract into the
 * cache key: `['recipes', 'group', groupId, page, sort]`. `pageSize` is
 * only appended when the caller overrides the default (24) so the
 * common grid consumer doesn't fragment the cache. Invalidation after a
 * mutation still broadcasts via the `['recipes', 'group', groupId]`
 * prefix — matches the old behaviour.
 */
export const recipeQueryKeys = {
  all: ['recipes'] as const,
  forGroup: (
    groupId: string,
    page = 1,
    sort: RecipeListSort = 'updated_desc',
    pageSize?: number,
  ) =>
    (pageSize != null && pageSize !== DEFAULT_RECIPE_LIST_PAGE_SIZE
      ? ([...recipeQueryKeys.all, 'group', groupId, page, sort, pageSize] as const)
      : ([...recipeQueryKeys.all, 'group', groupId, page, sort] as const)),
  detail: (id: string) => [...recipeQueryKeys.all, 'detail', id] as const,
  /**
   * COVER-0 Slice E — cache key for `GET /api/recipes/:id/origin-import`.
   * Dedicated family so the RecipeDetailPage can gate the "Cover ändern"
   * button on its result without re-invalidating every time the detail
   * DTO refreshes.
   */
  originImport: (id: string) =>
    [...recipeQueryKeys.all, 'origin-import', id] as const,
  revisions: (id: string) => [...recipeQueryKeys.all, 'revisions', id] as const,
  revision: (id: string, revisionId: string) =>
    [...recipeQueryKeys.all, 'revisions', id, revisionId] as const,
  /**
   * LANG-2 — cache key for the cached translation payload of a recipe
   * into a target UI language. The TanStack-Query mutation deduplicates
   * concurrent translate clicks via this key (re-clicking while in
   * flight returns the in-flight promise rather than firing a second
   * LLM call). Per-(recipe, language) granularity so toggling the UI
   * language mid-session keeps both translations cached locally.
   */
  translation: (id: string, lang: string) =>
    [...recipeQueryKeys.all, 'translation', id, lang] as const,
  tagsForGroup: (groupId: string) => ['tags', 'group', groupId] as const,
}
