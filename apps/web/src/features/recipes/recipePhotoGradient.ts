/**
 * Gradient photo fallbacks for recipe cards when no real cover photo
 * is uploaded yet. The four gradients are copied verbatim from
 * `.recipe-photo-{1..4}` in `docs/mockups/variant-a-home.html` so
 * the Home page feels cohesive with the DS8 Sage Modern spec until
 * real photos land.
 *
 * `recipePhotoGradient(id)` is deterministic: same id → same swatch,
 * different ids → variety. The hash is a tiny FNV-1a variant over the
 * UTF-16 code units of the id string; bag-of-tricks but plenty uniform
 * for this visual distribution job.
 */
export const RECIPE_PHOTO_GRADIENTS: readonly string[] = [
  // recipe-photo-1 — sage / deep-green
  'linear-gradient(135deg, #a8c0b0 0%, #4f7961 100%)',
  // recipe-photo-2 — coral / burnt-terracotta
  'linear-gradient(135deg, #e9b99c 0%, #c26b43 100%)',
  // recipe-photo-3 — olive / herbal-green
  'linear-gradient(135deg, #d8e0b5 0%, #7a9a30 100%)',
  // recipe-photo-4 — wheat / toasted-brown
  'linear-gradient(135deg, #d9b88f 0%, #8f5f2b 100%)',
] as const

/** FNV-1a 32-bit hash — tiny and no deps. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return hash >>> 0
}

export function recipePhotoGradient(recipeId: string): string {
  const idx = fnv1a(recipeId) % RECIPE_PHOTO_GRADIENTS.length
  return RECIPE_PHOTO_GRADIENTS[idx]!
}
