import { describe, expect, it } from 'vitest'
import type {
  RecipeDetailDto,
  RecipeTranslationPayload,
} from '@familien-kochbuch/shared'
import { applyTranslation } from './applyTranslation'

const sampleRecipe: RecipeDetailDto = {
  id: 'r1',
  groupId: 'g1',
  createdByUserId: 'u1',
  createdByDisplayName: 'Alice',
  title: 'Spätzle',
  description: 'Schwäbisch.',
  defaultServings: 4,
  prepTimeMinutes: 30,
  difficulty: 1,
  sourceUrl: null,
  sourceType: 'Manual',
  forkOfRecipeId: null,
  photos: ['https://example.com/spaetzle.jpg'],
  lastCookedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  version: 1,
  components: [
    {
      id: 'c1',
      position: 0,
      label: null,
      ingredients: [
        { position: 0, quantity: 500, unit: 'g', name: 'Mehl', note: null, scalable: true },
        { position: 1, quantity: 4, unit: 'Stk', name: 'Eier', note: 'frisch', scalable: true },
      ],
      steps: [
        { position: 0, content: 'Mehl sieben.' },
      ],
    },
  ],
  tags: [
    { id: 't1', name: 'deutsch', category: 'Kueche' as const, isGlobal: true },
  ],
  nutritionEstimate: null,
  sourceLanguage: 'de',
}

describe('applyTranslation', () => {
  it('overlays title + description from the payload', () => {
    const payload: RecipeTranslationPayload = {
      title: 'Spaetzle',
      description: 'Swabian noodles.',
      components: [],
      tags: [],
    }
    const result = applyTranslation(sampleRecipe, payload)
    expect(result.title).toBe('Spaetzle')
    expect(result.description).toBe('Swabian noodles.')
  })

  it('preserves photos / ids / numeric quantities byte-for-byte', () => {
    const payload: RecipeTranslationPayload = {
      title: 'Spaetzle',
      description: 'Swabian.',
      components: [
        {
          id: 'c1',
          position: 0,
          label: null,
          ingredients: [
            { position: 0, name: 'Flour', unit: 'g', note: null },
            { position: 1, name: 'Eggs', unit: 'pcs', note: 'fresh' },
          ],
          steps: [
            { position: 0, content: 'Sift the flour.' },
          ],
        },
      ],
      tags: [{ id: 't1', name: 'german' }],
    }
    const result = applyTranslation(sampleRecipe, payload)
    expect(result.id).toBe('r1')
    expect(result.photos).toEqual(['https://example.com/spaetzle.jpg'])
    expect(result.version).toBe(1)
    expect(result.components[0].ingredients[0].quantity).toBe(500)
    expect(result.components[0].ingredients[1].quantity).toBe(4)
  })

  it('overlays ingredient names + units + notes when matching by id+position', () => {
    const payload: RecipeTranslationPayload = {
      title: 'X',
      components: [
        {
          id: 'c1',
          position: 0,
          label: null,
          ingredients: [
            { position: 0, name: 'Flour', unit: 'g', note: null },
            { position: 1, name: 'Eggs', unit: 'pcs', note: 'fresh' },
          ],
          steps: [{ position: 0, content: 'Sift.' }],
        },
      ],
      tags: [],
    }
    const result = applyTranslation(sampleRecipe, payload)
    expect(result.components[0].ingredients[0].name).toBe('Flour')
    expect(result.components[0].ingredients[0].unit).toBe('g')
    expect(result.components[0].ingredients[1].name).toBe('Eggs')
    expect(result.components[0].ingredients[1].note).toBe('fresh')
  })

  it('falls back to the original ingredient when payload position is missing', () => {
    const payload: RecipeTranslationPayload = {
      title: 'X',
      components: [
        {
          id: 'c1',
          position: 0,
          label: null,
          ingredients: [
            // Only translate position 0; position 1 ("Eier") missing.
            { position: 0, name: 'Flour', unit: 'g', note: null },
          ],
          steps: [],
        },
      ],
      tags: [],
    }
    const result = applyTranslation(sampleRecipe, payload)
    expect(result.components[0].ingredients[0].name).toBe('Flour')
    // Position-1 ingredient is preserved verbatim.
    expect(result.components[0].ingredients[1].name).toBe('Eier')
  })

  it('falls back to original component when payload component is missing entirely', () => {
    const payload: RecipeTranslationPayload = {
      title: 'X',
      components: [], // no components at all
      tags: [],
    }
    const result = applyTranslation(sampleRecipe, payload)
    expect(result.components[0].ingredients[0].name).toBe('Mehl')
    expect(result.components[0].steps[0].content).toBe('Mehl sieben.')
  })

  it('overlays tag names by id', () => {
    const payload: RecipeTranslationPayload = {
      title: 'X',
      components: [],
      tags: [{ id: 't1', name: 'german' }],
    }
    const result = applyTranslation(sampleRecipe, payload)
    expect(result.tags[0].name).toBe('german')
    expect(result.tags[0].id).toBe('t1')
  })
})
