import { useQuery } from '@tanstack/react-query'
import type { RecipeSearchParams, RecipeSearchResult } from '@familien-kochbuch/shared'
import { searchRecipes } from './searchApi'

export const searchQueryKeys = {
  all: ['search'] as const,
  forGroup: (groupId: string, params: RecipeSearchParams) =>
    [...searchQueryKeys.all, 'group', groupId, params] as const,
}

export function useRecipeSearch(
  groupId: string | undefined,
  params: RecipeSearchParams,
) {
  return useQuery<RecipeSearchResult>({
    queryKey: groupId
      ? searchQueryKeys.forGroup(groupId, params)
      : ['search', 'group', 'disabled'],
    queryFn: () => searchRecipes(groupId!, params),
    enabled: !!groupId,
  })
}
