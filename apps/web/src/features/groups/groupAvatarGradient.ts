/**
 * Gradient swatches for the overlapping group avatar on
 * `<GroupDetailHeader />` (DS4).
 *
 * Colors come verbatim from the `.member-chip.m1/.m2/.m3` rules in
 * `docs/mockups/warme-kueche-group-detail.html`, extrapolated to the
 * larger 72 px square: amber, rose, and sage tints on a warm cream
 * background. The helper hashes on `groupId` so the same group always
 * draws the same swatch, while different groups get variety.
 *
 * The returned object ships a background CSS value and a foreground text
 * color tuned to remain legible against the swatch (dark amber / dark
 * maroon / dark moss respectively).
 */
export interface GroupAvatarGradient {
  readonly background: string
  readonly color: string
}

export const GROUP_AVATAR_GRADIENTS: readonly GroupAvatarGradient[] = [
  // amber — primary Warme-Küche tint, matches the mockup's default avatar
  {
    background: 'linear-gradient(135deg, #fde68a 0%, #fbbf24 100%)',
    color: '#713f12',
  },
  // rose — warm companion tint
  {
    background: 'linear-gradient(135deg, #fecaca 0%, #fca5a5 100%)',
    color: '#7f1d1d',
  },
  // sage — cooler green tint for variety
  {
    background: 'linear-gradient(135deg, #d9f99d 0%, #a3e635 100%)',
    color: '#365314',
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
