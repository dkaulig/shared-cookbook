/**
 * Gradient swatches for the overlapping group avatar on
 * `<GroupDetailHeader />` (DS4, retinted for DS8 Sage Modern).
 *
 * Colors mirror the `.group-avatar.tint-{1,2,3}` rules in
 * `docs/mockups/variant-a-home.html`: a sage, a coral-terracotta, and
 * an olive swatch sitting on the Sage Modern cream background. The
 * helper hashes on `groupId` so the same group always draws the same
 * swatch, while different groups get variety.
 *
 * The returned object ships a background CSS value and a foreground
 * text color tuned to remain legible against each swatch (deep sage,
 * warm terracotta, and deep olive respectively).
 */
export interface GroupAvatarGradient {
  readonly background: string
  readonly color: string
}

export const GROUP_AVATAR_GRADIENTS: readonly GroupAvatarGradient[] = [
  // sage — primary Sage Modern tint, matches the mockup's default avatar
  {
    background: 'linear-gradient(135deg, #c3d4ca 0%, #8daea0 100%)',
    color: '#2b4435',
  },
  // coral — warm terracotta companion tint
  {
    background: 'linear-gradient(135deg, #f0c9b6 0%, #d9a281 100%)',
    color: '#7a3f21',
  },
  // olive — cooler herbal green tint for variety
  {
    background: 'linear-gradient(135deg, #d9e0b5 0%, #b6c27e 100%)',
    color: '#4f5b1f',
  },
] as const

/** FNV-1a 32-bit hash — tiny, dep-free, uniform-enough for 3-bucket mapping. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return hash >>> 0
}

export function getGroupAvatarGradient(groupId: string): GroupAvatarGradient {
  const idx = fnv1a(groupId) % GROUP_AVATAR_GRADIENTS.length
  return GROUP_AVATAR_GRADIENTS[idx]!
}
