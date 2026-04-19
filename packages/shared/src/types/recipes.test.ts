import { describe, expect, it } from 'vitest'
import type {
  CreateRecipeRequest,
  NutritionEstimate,
  RecipeDetailDto,
} from './recipes.ts'
import type { ExtractedNutritionEstimate, ExtractedRecipe } from './imports.ts'

/**
 * Type-level regression tests for the P2-10 nutrition additions. Pin
 * the wire shape with the .NET DTO (`RecipeDetailDto.NutritionEstimate`)
 * + the Python pipeline (`ExtractedRecipe.nutrition_estimate`). A
 * breaking rename on either side fails here.
 */

describe('recipes.ts NutritionEstimate (P2-10)', () => {
  it('NutritionEstimate carries the four camelCase fields', () => {
    const estimate: NutritionEstimate = {
      kcal: 420,
      proteinG: 24,
      carbsG: 38,
      fatG: 9,
    }
    expect(estimate.kcal).toBe(420)
    expect(estimate.proteinG).toBe(24)
    expect(estimate.carbsG).toBe(38)
    expect(estimate.fatG).toBe(9)
  })

  it('RecipeDetailDto exposes nutritionEstimate as non-optional (null-when-absent)', () => {
    // The DTO key is required (non-optional) — the API always sends the
    // field, and `null` means "no estimate". That's load-bearing: if the
    // key were optional the detail page would need an extra undefined
    // check to avoid a flash of "undefined" in the nährwerte badge.
    const withEstimate: RecipeDetailDto = {
      id: 'r1',
      groupId: 'g1',
      createdByUserId: 'u1',
      createdByDisplayName: 'David',
      title: 'Testrezept',
      defaultServings: 4,
      difficulty: 2,
      sourceType: 'Manual',
      photos: [],
      createdAt: '2026-04-18T00:00:00Z',
      updatedAt: '2026-04-18T00:00:00Z',
      ingredients: [],
      steps: [],
      tags: [],
      nutritionEstimate: { kcal: 300, proteinG: 10, carbsG: 30, fatG: 8 },
    }
    expect(withEstimate.nutritionEstimate?.kcal).toBe(300)

    const withoutEstimate: RecipeDetailDto = {
      ...withEstimate,
      nutritionEstimate: null,
    }
    expect(withoutEstimate.nutritionEstimate).toBeNull()
  })

  it('CreateRecipeRequest accepts optional nutritionEstimate (omit / null / value)', () => {
    const noField: CreateRecipeRequest = {
      title: 'X',
      defaultServings: 2,
      difficulty: 1,
      ingredients: [],
      steps: [],
      tagIds: [],
    }
    expect(noField.nutritionEstimate).toBeUndefined()

    const nullField: CreateRecipeRequest = { ...noField, nutritionEstimate: null }
    expect(nullField.nutritionEstimate).toBeNull()

    const withField: CreateRecipeRequest = {
      ...noField,
      nutritionEstimate: { kcal: 500, proteinG: 12, carbsG: 44, fatG: 15 },
    }
    expect(withField.nutritionEstimate?.kcal).toBe(500)
  })
})

describe('imports.ts ExtractedNutritionEstimate (P2-10)', () => {
  it('ExtractedNutritionEstimate uses Python snake_case field names', () => {
    const estimate: ExtractedNutritionEstimate = {
      kcal: 420,
      protein_g: 24,
      carbs_g: 38,
      fat_g: 9,
    }
    expect(estimate.protein_g).toBe(24)
    expect(estimate.carbs_g).toBe(38)
    expect(estimate.fat_g).toBe(9)
  })

  it('ExtractedRecipe carries optional nutrition_estimate (null or object)', () => {
    const recipeWithEstimate: ExtractedRecipe = {
      title: 'Kaiserschmarrn',
      description: null,
      servings: 4,
      difficulty: null,
      prep_minutes: null,
      cook_minutes: null,
      ingredients: [],
      steps: [],
      tags: [],
      source_url: 'https://example.com/x',
      thumbnail_url: null,
      nutrition_estimate: { kcal: 380, protein_g: 6, carbs_g: 52, fat_g: 14 },
    }
    expect(recipeWithEstimate.nutrition_estimate?.kcal).toBe(380)

    const recipeWithoutEstimate: ExtractedRecipe = {
      ...recipeWithEstimate,
      nutrition_estimate: null,
    }
    expect(recipeWithoutEstimate.nutrition_estimate).toBeNull()

    // The field is optional so legacy payloads (no key) still type.
    const recipeOmitsEstimate: ExtractedRecipe = {
      title: 'T',
      description: null,
      servings: null,
      difficulty: null,
      prep_minutes: null,
      cook_minutes: null,
      ingredients: [],
      steps: [],
      tags: [],
      source_url: 'https://example.com/x',
      thumbnail_url: null,
    }
    expect(recipeOmitsEstimate.nutrition_estimate).toBeUndefined()
  })
})
