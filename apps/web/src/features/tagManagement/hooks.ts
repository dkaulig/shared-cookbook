import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { TagDto } from '@familien-kochbuch/shared'
import { createGroupTag, deleteGroupTag, type CreateTagRequest } from './tagsApi'
import { recipeQueryKeys } from '@/features/recipes/queryKeys'

export function useCreateGroupTag(groupId: string) {
  const client = useQueryClient()
  return useMutation<TagDto, Error, CreateTagRequest>({
    mutationFn: (body) => createGroupTag(groupId, body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: recipeQueryKeys.tagsForGroup(groupId) })
    },
  })
}

export function useDeleteGroupTag(groupId: string) {
  const client = useQueryClient()
  return useMutation<void, Error, string>({
    mutationFn: (tagId) => deleteGroupTag(groupId, tagId),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: recipeQueryKeys.tagsForGroup(groupId) })
      // Any recipe using the deleted tag sees its tag list shrink.
      void client.invalidateQueries({ queryKey: recipeQueryKeys.all })
    },
  })
}
