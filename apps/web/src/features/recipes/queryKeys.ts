/**
 * Centralised TanStack Query cache keys for the recipes feature. Keeping
 * them here ensures mutation hooks invalidate the exact same keys that
 * query hooks read.
 */
export const recipeQueryKeys = {
  all: ['recipes'] as const,
  forGroup: (groupId: string, page = 1, pageSize = 20) =>
    [...recipeQueryKeys.all, 'group', groupId, 'page', page, pageSize] as const,
  detail: (id: string) => [...recipeQueryKeys.all, 'detail', id] as const,
  revisions: (id: string) => [...recipeQueryKeys.all, 'revisions', id] as const,
  revision: (id: string, revisionId: string) =>
    [...recipeQueryKeys.all, 'revisions', id, revisionId] as const,
  tagsForGroup: (groupId: string) => ['tags', 'group', groupId] as const,
}
