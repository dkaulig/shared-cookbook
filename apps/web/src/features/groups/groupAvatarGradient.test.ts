import { describe, expect, it } from 'vitest'
import {
  getGroupAvatarGradient,
  GROUP_AVATAR_GRADIENTS,
} from './groupAvatarGradient'

/**
 * Deterministic avatar-gradient helper for `<GroupDetailHeader />` (DS4).
 *
 * The mockup (`docs/mockups/warme-kueche-group-detail.html`) renders the
 * overlapping group avatar with a warm amber-tinted gradient. We expose
 * three tinted gradients (amber, rose, sage) so the 3–5 groups a typical
 * household maintains look visually distinct without a real cover image.
 *
 * Hashing is on `groupId` so the same group always renders the same
 * swatch, while different groups get variety.
 */
describe('getGroupAvatarGradient', () => {
  it('exposes at least three tinted gradient variants', () => {
    expect(GROUP_AVATAR_GRADIENTS.length).toBeGreaterThanOrEqual(3)
    for (const gradient of GROUP_AVATAR_GRADIENTS) {
      expect(gradient.background).toMatch(/linear-gradient/)
      expect(gradient.color).toMatch(/^#/)
    }
  })

  it('is deterministic — same id returns the same gradient', () => {
    expect(getGroupAvatarGradient('group-a')).toStrictEqual(
      getGroupAvatarGradient('group-a'),
    )
    expect(getGroupAvatarGradient('42')).toStrictEqual(
      getGroupAvatarGradient('42'),
    )
  })

  it('distributes different ids across the gradient pool', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']
    const variants = new Set(
      ids.map((id) => getGroupAvatarGradient(id).background),
    )
    expect(variants.size).toBeGreaterThan(1)
  })

  it('always returns a gradient from the GROUP_AVATAR_GRADIENTS pool', () => {
    for (const id of ['x', 'y', 'zzz', '123', '']) {
      expect(GROUP_AVATAR_GRADIENTS).toContain(getGroupAvatarGradient(id))
    }
  })
})
