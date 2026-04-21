import { useRecipes } from './hooks'

/**
 * "Zuletzt gekocht" — the Home page's recent-recipes section.
 *
 * PAGE-1 — rides the paginated recipe-list endpoint
 * (`/api/groups/:groupId/recipes?pageSize=5&sort=cooked_desc`). Same
 * server-side ordering contract as the Group Detail page's
 * "Zuletzt gekocht" sort so the two views stay in sync.
 */
export function useRecentlyCooked(groupId: string | undefined, pageSize = 5) {
  return useRecipes(groupId, { page: 1, pageSize, sort: 'cooked_desc' })
}
