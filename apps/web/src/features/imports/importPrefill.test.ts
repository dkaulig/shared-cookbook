import { describe, expect, it } from 'vitest'
import type { ExtractedRecipe } from '@familien-kochbuch/shared'
import { extractedRecipeToPrefill } from './importPrefill'

function recipe(over: Partial<ExtractedRecipe> = {}): ExtractedRecipe {
  return {
    title: 'Pizza',
    description: null,
    servings: null,
    difficulty: null,
    prep_minutes: null,
    cook_minutes: null,
    ingredients: [],
    steps: [],
    tags: [],
    source_url: 'https://example.com',
    thumbnail_url: null,
    ...over,
  }
}

describe('extractedRecipeToPrefill', () => {
  it('passes title, description, sourceUrl through', () => {
    const out = extractedRecipeToPrefill(
      recipe({
        title: 'Apfelkuchen',
        description: 'Klassiker',
        source_url: 'https://www.chefkoch.de/apfelkuchen',
      }),
    )
    expect(out.title).toBe('Apfelkuchen')
    expect(out.description).toBe('Klassiker')
    expect(out.sourceUrl).toBe('https://www.chefkoch.de/apfelkuchen')
  })

  it('defaults servings to 4 when the extractor was silent', () => {
    expect(extractedRecipeToPrefill(recipe({ servings: null })).defaultServings).toBe(4)
  })

  it('keeps the extractor servings when provided', () => {
    expect(extractedRecipeToPrefill(recipe({ servings: 2 })).defaultServings).toBe(2)
  })

  it('sums prep + cook minutes when provided', () => {
    const out = extractedRecipeToPrefill(
      recipe({ prep_minutes: 20, cook_minutes: 45 }),
    )
    expect(out.prepTimeMinutes).toBe(65)
  })

  it('leaves prepTimeMinutes null when both prep and cook are null', () => {
    expect(extractedRecipeToPrefill(recipe()).prepTimeMinutes).toBeNull()
  })

  it('clamps difficulty into the 1..3 scale', () => {
    expect(extractedRecipeToPrefill(recipe({ difficulty: 0 })).difficulty).toBe(1)
    expect(extractedRecipeToPrefill(recipe({ difficulty: 2 })).difficulty).toBe(2)
    expect(extractedRecipeToPrefill(recipe({ difficulty: 9 })).difficulty).toBe(3)
    // Null → default 1.
    expect(extractedRecipeToPrefill(recipe({ difficulty: null })).difficulty).toBe(1)
  })

  it('maps an ingredient with a missing quantity → scalable:false + confidence preserved', () => {
    const out = extractedRecipeToPrefill(
      recipe({
        ingredients: [
          {
            name: 'Mehl',
            quantity: null,
            unit: 'g',
            note: null,
            confidence: 'missing',
          },
        ],
      }),
    )
    expect(out.ingredients[0]).toMatchObject({
      name: 'Mehl',
      quantity: '',
      scalable: false,
      confidence: 'missing',
    })
  })

  it('preserves quantity as a string and marks scalable true when quantity present', () => {
    const out = extractedRecipeToPrefill(
      recipe({
        ingredients: [
          {
            name: 'Mehl',
            quantity: '500',
            unit: 'g',
            note: null,
            confidence: 'high',
          },
        ],
      }),
    )
    expect(out.ingredients[0].quantity).toBe('500')
    expect(out.ingredients[0].scalable).toBe(true)
  })

  it('canonicalises a case-variant unit to the form select option', () => {
    const out = extractedRecipeToPrefill(
      recipe({
        ingredients: [
          {
            name: 'Milch',
            quantity: '500',
            unit: 'ML',
            note: null,
            confidence: 'high',
          },
        ],
      }),
    )
    expect(out.ingredients[0].unit).toBe('ml')
  })

  it('falls back to "g" when the LLM emitted a null unit', () => {
    const out = extractedRecipeToPrefill(
      recipe({
        ingredients: [
          {
            name: 'Zucker',
            quantity: '100',
            unit: null,
            note: null,
            confidence: 'high',
          },
        ],
      }),
    )
    expect(out.ingredients[0].unit).toBe('g')
  })

  it('preserves the handwritten_uncertain confidence marker end-to-end', () => {
    const out = extractedRecipeToPrefill(
      recipe({
        ingredients: [
          {
            name: 'Muskat',
            quantity: null,
            unit: 'Prise',
            note: null,
            confidence: 'handwritten_uncertain',
          },
        ],
        steps: [
          {
            position: 1,
            content: 'Mit Muskat abschmecken.',
            confidence: 'handwritten_uncertain',
          },
        ],
      }),
    )
    expect(out.ingredients[0].confidence).toBe('handwritten_uncertain')
    expect(out.steps[0].confidence).toBe('handwritten_uncertain')
  })

  it('flags URL-based imports as isPhotoImport:false with the URL passed through', () => {
    const out = extractedRecipeToPrefill(
      recipe({ source_url: 'https://example.com/blog/recipe' }),
    )
    expect(out.isPhotoImport).toBe(false)
    expect(out.sourceUrl).toBe('https://example.com/blog/recipe')
  })

  it('detects the photos:// sentinel, blanks sourceUrl, and flags isPhotoImport:true', () => {
    // The Python photo pipeline pins `source_url` to this sentinel so
    // the ExtractedRecipe schema stays populated. The frontend must not
    // persist it on the saved recipe and must render a photo-aware
    // banner instead of the "AI-Vorschlag aus {url}" copy.
    const out = extractedRecipeToPrefill(
      recipe({ source_url: 'photos://upload' }),
    )
    expect(out.isPhotoImport).toBe(true)
    expect(out.sourceUrl).toBe('')
  })
})
