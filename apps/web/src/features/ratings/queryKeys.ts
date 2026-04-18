/**
 * TanStack Query cache keys for the ratings feature.
 */
export const ratingQueryKeys = {
  all: ['ratings'] as const,
  forRecipe: (recipeId: string) => [...ratingQueryKeys.all, 'recipe', recipeId] as const,
}
