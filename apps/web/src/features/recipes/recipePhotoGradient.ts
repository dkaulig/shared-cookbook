/**
 * Gradient photo fallbacks for recipe cards when no real cover photo
 * is uploaded yet. The four gradients are copied verbatim from
 * `.recipe-photo-{1..4}` in `docs/mockups/warme-kueche-home.html` so
 * the Home page feels cohesive with the design spec until real photos
 * land.
 *
 * `recipePhotoGradient(id)` is deterministic: same id → same swatch,
 * different ids → variety. The hash is a tiny FNV-1a variant over the
 * UTF-16 code units of the id string; bag-of-tricks but plenty uniform
 * for this visual distribution job.
 */
export const RECIPE_PHOTO_GRADIENTS: readonly string[] = [
  // recipe-photo-1 — amber / caramel
  'linear-gradient(135deg, rgba(146,64,14,0.35), rgba(180,83,9,0.2)), radial-gradient(circle at 30% 40%, #fbbf24 0%, #b45309 60%)',
  // recipe-photo-2 — deep red / cranberry
  'linear-gradient(135deg, rgba(127,29,29,0.3), rgba(220,38,38,0.15)), radial-gradient(circle at 70% 60%, #fca5a5 0%, #991b1b 60%)',
  // recipe-photo-3 — herb green / lime
  'linear-gradient(135deg, rgba(22,101,52,0.2), rgba(132,204,22,0.15)), radial-gradient(circle at 40% 60%, #bef264 0%, #4d7c0f 60%)',
  // recipe-photo-4 — toasted wheat / amber-cream
  'linear-gradient(135deg, rgba(180,83,9,0.25), rgba(252,211,77,0.1)), radial-gradient(circle at 60% 40%, #fde68a 0%, #78350f 70%)',
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
