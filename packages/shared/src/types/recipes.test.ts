import { describe, expect, it } from 'vitest'
import type {
  CreateRecipeRequest,
  NutritionEstimate,
  RecipeComponentDto,
  RecipeDetailDto,
} from './recipes.ts'
import type {
  ExtractedComponent,
  ExtractedNutritionEstimate,
  ExtractedRecipe,
} from './imports.ts'

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
      version: 0,
      components: [
        { id: 'c1', position: 0, label: null, ingredients: [], steps: [] },
      ],
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
      components: [
        { position: 0, label: null, ingredients: [], steps: [] },
      ],
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
      components: [{ label: null, position: 0, ingredients: [], steps: [] }],
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
      components: [{ label: null, position: 0, ingredients: [], steps: [] }],
      tags: [],
      source_url: 'https://example.com/x',
      thumbnail_url: null,
    }
    expect(recipeOmitsEstimate.nutrition_estimate).toBeUndefined()
  })
})

// COMP-2 — drift guard for the nested `components` field across the
// shared DTOs and the extractor wire shape. Existence of these three
// shapes (RecipeComponentDto on the detail / create / update response;
// ExtractedComponent on the Python emit) is load-bearing: a rename on
// any one side breaks the whole pipeline.
describe('recipes.ts RecipeComponentDto (COMP-2)', () => {
  it('RecipeComponentDto carries position + nullable label + nested ingredients/steps', () => {
    const component: RecipeComponentDto = {
      id: 'c1',
      position: 0,
      label: 'Chipotle Sauce',
      ingredients: [
        { position: 0, quantity: 2, unit: 'EL', name: 'Honig', scalable: true },
      ],
      steps: [{ position: 0, content: 'Mischen.' }],
    }
    expect(component.label).toBe('Chipotle Sauce')
    expect(component.ingredients).toHaveLength(1)
    expect(component.steps).toHaveLength(1)
  })

  it('RecipeComponentDto.label accepts null for the single-default case', () => {
    const component: RecipeComponentDto = {
      id: 'c-default',
      position: 0,
      label: null,
      ingredients: [],
      steps: [],
    }
    expect(component.label).toBeNull()
  })

  it('RecipeDetailDto.components replaces the old top-level ingredients/steps', () => {
    const detail: RecipeDetailDto = {
      id: 'r1',
      groupId: 'g1',
      createdByUserId: 'u1',
      createdByDisplayName: 'David',
      title: 'Quesadilla',
      defaultServings: 4,
      difficulty: 2,
      sourceType: 'Manual',
      photos: [],
      createdAt: '2026-04-21T00:00:00Z',
      updatedAt: '2026-04-21T00:00:00Z',
      version: 0,
      components: [
        { id: 'c1', position: 0, label: 'Chipotle Sauce', ingredients: [], steps: [] },
        { id: 'c2', position: 1, label: null, ingredients: [], steps: [] },
      ],
      tags: [],
      nutritionEstimate: null,
    }
    expect(detail.components).toHaveLength(2)
    expect(detail.components[0]?.label).toBe('Chipotle Sauce')
    // Old flat keys must NOT exist on the type — this cast would widen
    // to `unknown` if they did, but the property access is still a
    // runtime-only check; the TS failure materialises on the DTO
    // construction above if a consumer tries to pass `ingredients` /
    // `steps` directly.
    expect('ingredients' in detail).toBe(false)
    expect('steps' in detail).toBe(false)
  })

  it('CreateRecipeRequest.components replaces the old top-level ingredients/steps', () => {
    const body: CreateRecipeRequest = {
      title: 'Quesadilla',
      defaultServings: 4,
      difficulty: 2,
      components: [
        {
          position: 0,
          label: 'Chipotle Sauce',
          ingredients: [
            { position: 0, quantity: 2, unit: 'EL', name: 'Honig', scalable: true },
          ],
          steps: [{ position: 0, content: 'Mischen.' }],
        },
        {
          position: 1,
          label: null,
          ingredients: [
            { position: 0, quantity: 1, unit: 'Stück', name: 'Tortilla', scalable: true },
          ],
          steps: [{ position: 0, content: 'Anbraten.' }],
        },
      ],
      tagIds: [],
    }
    expect(body.components).toHaveLength(2)
    expect('ingredients' in body).toBe(false)
    expect('steps' in body).toBe(false)
  })
})

describe('imports.ts ExtractedComponent (COMP-2)', () => {
  it('ExtractedComponent mirrors the Python ExtractedComponent shape', () => {
    const component: ExtractedComponent = {
      label: 'Chipotle Sauce',
      position: 0,
      ingredients: [
        {
          name: 'Honig',
          quantity: '2',
          unit: 'EL',
          note: null,
          confidence: 'high',
        },
      ],
      steps: [
        { position: 1, content: 'Mischen.', confidence: 'high' },
      ],
    }
    expect(component.label).toBe('Chipotle Sauce')
    expect(component.position).toBe(0)
    expect(component.ingredients).toHaveLength(1)
  })

  it('ExtractedRecipe.components replaces flat ingredients/steps', () => {
    const recipe: ExtractedRecipe = {
      title: 'Quesadilla',
      description: null,
      servings: null,
      difficulty: null,
      prep_minutes: null,
      cook_minutes: null,
      components: [
        { label: 'Chipotle Sauce', position: 0, ingredients: [], steps: [] },
        { label: null, position: 1, ingredients: [], steps: [] },
      ],
      tags: [],
      source_url: 'https://example.com/q',
      thumbnail_url: null,
    }
    expect(recipe.components).toHaveLength(2)
    expect('ingredients' in recipe).toBe(false)
    expect('steps' in recipe).toBe(false)
  })
})
