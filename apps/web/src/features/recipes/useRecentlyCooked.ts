import { useQuery } from '@tanstack/react-query'
import type { RecipeSearchResult } from '@familien-kochbuch/shared'
import { searchRecipes } from '@/features/search/searchApi'

/**
 * "Zuletzt gekocht" — the Home page's recent-recipes section.
 *
 * Wraps the existing `/api/groups/:groupId/recipes/search` endpoint with
 * `sort=last_cooked&pageSize=4` so the Home page does not import the
 * search feature directly. Backed by the same URL (and the same server
 * ordering) as the Group Detail page's "zuletzt gekocht" sort, so the
 * two views stay in sync.
 */
export function useRecentlyCooked(groupId: string | undefined, pageSize = 4) {
  return useQuery<RecipeSearchResult>({
    queryKey: ['recentlyCooked', groupId ?? 'disabled', pageSize],
    queryFn: () => searchRecipes(groupId!, { sort: 'last_cooked', page: 1, pageSize }),
    enabled: !!groupId,
  })
}
