import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  RatingListResponse,
  UpsertRatingRequest,
  UpsertRatingResponse,
} from '@shared-cookbook/shared'
import { deleteRating, fetchRatings, upsertRating } from './ratingsApi'
import { ratingQueryKeys } from './queryKeys'
import { recipeQueryKeys } from '@/features/recipes/queryKeys'

export function useRatings(recipeId: string | undefined) {
  return useQuery<RatingListResponse>({
    queryKey: recipeId
      ? ratingQueryKeys.forRecipe(recipeId)
      : ['ratings', 'recipe', 'disabled'],
    queryFn: () => fetchRatings(recipeId!),
    enabled: !!recipeId,
  })
}

export function useUpsertRating(recipeId: string) {
  const client = useQueryClient()
  return useMutation<UpsertRatingResponse, Error, UpsertRatingRequest>({
    mutationFn: (body) => upsertRating(recipeId, body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ratingQueryKeys.forRecipe(recipeId) })
      void client.invalidateQueries({ queryKey: recipeQueryKeys.detail(recipeId) })
      // Search results carry rating aggregates — re-fetch the whole feature.
      void client.invalidateQueries({ queryKey: recipeQueryKeys.all })
    },
  })
}

export function useDeleteRating(recipeId: string) {
  const client = useQueryClient()
  return useMutation<void, Error, void>({
    mutationFn: () => deleteRating(recipeId),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ratingQueryKeys.forRecipe(recipeId) })
      void client.invalidateQueries({ queryKey: recipeQueryKeys.detail(recipeId) })
      void client.invalidateQueries({ queryKey: recipeQueryKeys.all })
    },
  })
}
