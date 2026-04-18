import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  CreateRecipeRequest,
  RecipeDetailDto,
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
  updateRecipe,
  uploadRecipePhoto,
} from './recipesApi'
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

export function useRemoveRecipePhoto(id: string) {
  const client = useQueryClient()
  return useMutation<void, Error, string>({
    mutationFn: (url) => deleteRecipePhoto(id, url),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: recipeQueryKeys.detail(id) })
    },
  })
}
