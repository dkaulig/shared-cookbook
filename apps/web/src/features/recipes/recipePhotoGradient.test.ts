import { describe, expect, it } from 'vitest'
import { recipePhotoGradient, RECIPE_PHOTO_GRADIENTS } from './recipePhotoGradient'

/**
 * Deterministic gradient CSS strings for the Home page's "Zuletzt gekocht"
 * cards when a recipe does not yet have a real photo. Mirrors the
 * `.recipe-photo-1 … recipe-photo-4` classes from
 * `docs/mockups/warme-kueche-home.html` so the visual reads the same.
 *
 * The helper hashes on recipe id so rerenders pick the same swatch for
 * the same recipe, and different recipes get visual variety.
 */
describe('recipePhotoGradient', () => {
  it('exposes at least four gradient variants from the mockup', () => {
    expect(RECIPE_PHOTO_GRADIENTS.length).toBeGreaterThanOrEqual(4)
    for (const gradient of RECIPE_PHOTO_GRADIENTS) {
      expect(gradient).toMatch(/linear-gradient/)
      expect(gradient).toMatch(/radial-gradient/)
    }
  })

  it('is deterministic — same id returns the same gradient', () => {
    expect(recipePhotoGradient('recipe-a')).toBe(recipePhotoGradient('recipe-a'))
    expect(recipePhotoGradient('42')).toBe(recipePhotoGradient('42'))
  })

  it('distributes different ids across the four gradient variants', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    const variants = new Set(ids.map((id) => recipePhotoGradient(id)))
    // With 8 ids and 4+ variants, at least two distinct gradients must
    // appear — otherwise the helper is degenerate.
    expect(variants.size).toBeGreaterThan(1)
  })

  it('always returns a gradient from the RECIPE_PHOTO_GRADIENTS pool', () => {
    for (const id of ['x', 'y', 'zzz', '123', '']) {
      expect(RECIPE_PHOTO_GRADIENTS).toContain(recipePhotoGradient(id))
    }
  })
})
