import {
  DEFAULT_RECIPE_LIST_PAGE_SIZE,
  type RecipeListSort,
} from '@familien-kochbuch/shared'

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
  revisions: (id: string) => [...recipeQueryKeys.all, 'revisions', id] as const,
  revision: (id: string, revisionId: string) =>
    [...recipeQueryKeys.all, 'revisions', id, revisionId] as const,
  tagsForGroup: (groupId: string) => ['tags', 'group', groupId] as const,
}
