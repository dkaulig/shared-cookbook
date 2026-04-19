import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  CreateRecipeRequest,
  ForkRecipeRequest,
  NutritionEstimate,
  RecipeDetailDto,
  RecipeRevisionDetail,
  RecipeRevisionSummary,
  RecipeSummaryListDto,
  TagDto,
  UpdateRecipeRequest,
  UploadPhotoResponse,
} from '@familien-kochbuch/shared'
import {
  createRecipe,
  deleteRecipe,
  deleteRecipePhoto,
  fetchGroupRecipes,
  fetchGroupTags,
  fetchRecipe,
  forkRecipe,
  markRecipeAsCooked,
  patchRecipeNutrition,
  updateRecipe,
  uploadRecipePhoto,
} from './recipesApi'
import { fetchRecipeRevision, fetchRecipeRevisions } from './revisionsApi'
import { recipeQueryKeys } from './queryKeys'
import { groupQueryKeys } from '@/features/groups/queryKeys'

/** List of recipes in a group (paginated). */
export function useGroupRecipes(groupId: string | undefined, page = 1, pageSize = 20) {
  return useQuery<RecipeSummaryListDto>({
    queryKey: groupId
      ? recipeQueryKeys.forGroup(groupId, page, pageSize)
      : ['recipes', 'group', 'disabled'],
    queryFn: () => fetchGroupRecipes(groupId!, page, pageSize),
    enabled: !!groupId,
  })
}

/** Full recipe detail, including ingredients, steps, tags. */
export function useRecipe(id: string | undefined) {
  return useQuery<RecipeDetailDto>({
    queryKey: id ? recipeQueryKeys.detail(id) : ['recipes', 'detail', 'disabled'],
    queryFn: () => fetchRecipe(id!),
    enabled: !!id,
  })
}

/** Global + group-scoped tags for a given group. */
export function useGroupTags(groupId: string | undefined) {
  return useQuery<TagDto[]>({
    queryKey: groupId ? recipeQueryKeys.tagsForGroup(groupId) : ['tags', 'group', 'disabled'],
    queryFn: () => fetchGroupTags(groupId!),
    enabled: !!groupId,
  })
}

// ── Mutations ───────────────────────────────────────────────────────

export function useCreateRecipe(groupId: string) {
  const client = useQueryClient()
  return useMutation<RecipeDetailDto, Error, CreateRecipeRequest>({
    mutationFn: (body) => createRecipe(groupId, body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: [...recipeQueryKeys.all, 'group', groupId] })
      void client.invalidateQueries({ queryKey: groupQueryKeys.detail(groupId) })
    },
  })
}

export function useUpdateRecipe(id: string, groupId?: string) {
  const client = useQueryClient()
  return useMutation<RecipeDetailDto, Error, UpdateRecipeRequest>({
    mutationFn: (body) => updateRecipe(id, body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: recipeQueryKeys.detail(id) })
      // S6: any successful PUT may have appended a new revision; refresh
      // the history so the panel re-renders without a manual reload.
      void client.invalidateQueries({ queryKey: recipeQueryKeys.revisions(id) })
      if (groupId) {
        void client.invalidateQueries({ queryKey: [...recipeQueryKeys.all, 'group', groupId] })
      }
    },
  })
}

export function useDeleteRecipe(groupId?: string) {
  const client = useQueryClient()
  return useMutation<void, Error, string>({
    mutationFn: deleteRecipe,
    onSuccess: (_data, id) => {
      void client.removeQueries({ queryKey: recipeQueryKeys.detail(id) })
      if (groupId) {
        void client.invalidateQueries({ queryKey: [...recipeQueryKeys.all, 'group', groupId] })
      }
    },
  })
}

export function useUploadRecipePhoto(id: string) {
  const client = useQueryClient()
  return useMutation<UploadPhotoResponse, Error, File>({
    mutationFn: (file) => uploadRecipePhoto(id, file),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: recipeQueryKeys.detail(id) })
    },
  })
}

export function useForkRecipe(id: string) {
  const client = useQueryClient()
  return useMutation<RecipeDetailDto, Error, ForkRecipeRequest>({
    mutationFn: (body) => forkRecipe(id, body),
    onSuccess: (data) => {
      // The new recipe lives in another group; refresh that group's list
      // and the new recipe's detail cache.
      void client.invalidateQueries({ queryKey: [...recipeQueryKeys.all, 'group', data.groupId] })
      void client.invalidateQueries({ queryKey: recipeQueryKeys.detail(data.id) })
    },
  })
}

/**
 * DS5 "Jetzt gekocht" mutation — POSTs `/api/recipes/{id}/cook` and
 * refreshes the recipe detail + any group list the recipe belongs to so
 * the recency sort picks up the new `lastCookedAt`. The updated detail
 * is seeded straight into the cache to avoid an extra round-trip.
 */
export function useMarkAsCooked(id: string) {
  const client = useQueryClient()
  return useMutation<RecipeDetailDto, Error, void>({
    mutationFn: () => markRecipeAsCooked(id),
    onSuccess: (detail) => {
      client.setQueryData(recipeQueryKeys.detail(id), detail)
      void client.invalidateQueries({
        queryKey: [...recipeQueryKeys.all, 'group', detail.groupId],
      })
      // Recency sort on Home may now differ — invalidate the
      // "recently cooked" query family so it re-runs.
      void client.invalidateQueries({ queryKey: ['recentlyCooked'] })
    },
  })
}

/**
 * P2-10 — PATCH the per-portion nutrition estimate on a recipe. `null`
 * body clears the stored estimate, a populated object replaces it. The
 * refreshed detail DTO is written straight into the TanStack cache so
 * the UI reflects the edit without a follow-up GET.
 */
export function useUpdateRecipeNutrition(id: string) {
  const client = useQueryClient()
  return useMutation<RecipeDetailDto, Error, NutritionEstimate | null>({
    mutationFn: (body) => patchRecipeNutrition(id, body),
    onSuccess: (detail) => {
      client.setQueryData(recipeQueryKeys.detail(id), detail)
    },
  })
}

export function useRemoveRecipePhoto(id: string) {
  const client = useQueryClient()
  return useMutation<void, Error, string>({
    mutationFn: (url) => deleteRecipePhoto(id, url),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: recipeQueryKeys.detail(id) })
    },
  })
}

// ── S6: Version history ────────────────────────────────────────────────

/** Last 5 revision summaries for a recipe. */
export function useRecipeRevisions(recipeId: string | undefined) {
  return useQuery<RecipeRevisionSummary[]>({
    queryKey: recipeId
      ? recipeQueryKeys.revisions(recipeId)
      : ['recipes', 'revisions', 'disabled'],
    queryFn: () => fetchRecipeRevisions(recipeId!),
    enabled: !!recipeId,
  })
}

/** Full snapshot for a single revision — fetched on demand when the
 *  diff modal opens. */
export function useRecipeRevision(
  recipeId: string | undefined,
  revisionId: string | undefined,
) {
  return useQuery<RecipeRevisionDetail>({
    queryKey: recipeId && revisionId
      ? recipeQueryKeys.revision(recipeId, revisionId)
      : ['recipes', 'revisions', 'detail', 'disabled'],
    queryFn: () => fetchRecipeRevision(recipeId!, revisionId!),
    enabled: !!(recipeId && revisionId),
  })
}
