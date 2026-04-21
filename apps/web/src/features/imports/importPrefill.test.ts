import { describe, expect, it } from 'vitest'
import type { ExtractedRecipe, ExtractionResult } from '@familien-kochbuch/shared'
import {
  extractedRecipeToPrefill,
  extractedResultToPrefill,
  withImportEnvelope,
} from './importPrefill'

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

  // ── P2-10 — Nutrition estimate ─────────────────────────────────

  it('defaults nutritionEstimate to null when the extractor omitted the field', () => {
    const out = extractedRecipeToPrefill(recipe())
    expect(out.nutritionEstimate).toBeNull()
  })

  it('defaults nutritionEstimate to null when the extractor emitted explicit null', () => {
    const out = extractedRecipeToPrefill(
      recipe({ nutrition_estimate: null }),
    )
    expect(out.nutritionEstimate).toBeNull()
  })

  it('maps the Python snake_case nutrition estimate onto camelCase for the form', () => {
    const out = extractedRecipeToPrefill(
      recipe({
        nutrition_estimate: { kcal: 420, protein_g: 24, carbs_g: 38, fat_g: 9 },
      }),
    )
    expect(out.nutritionEstimate).toEqual({
      kcal: 420,
      proteinG: 24,
      carbsG: 38,
      fatG: 9,
    })
  })

  // ── BUG-045 — AI tag names surfaced onto the prefill ───────────

  it('surfaces AI tag names onto the prefill so the form can pre-select them', () => {
    // User quote: "bisher wurde noch nie ein tag beim rezept import aus
    // videos ausgewählt". The extractor emits tags; the frontend never
    // carried them onto the prefill, so the form had nothing to pre-
    // select. This test pins the prefill-level shape.
    const out = extractedRecipeToPrefill(
      recipe({ tags: ['vegetarisch', 'schnell'] }),
    )
    expect(out.tags).toEqual(['vegetarisch', 'schnell'])
  })

  it('defaults tags to [] when the extractor returned an empty array', () => {
    const out = extractedRecipeToPrefill(recipe({ tags: [] }))
    expect(out.tags).toEqual([])
  })

  // ── BUG-018 — auto-attached video-thumbnail staged-photo id ─────

  it('defaults thumbnailStagedPhotoId to null when no envelope is supplied', () => {
    // The bare recipe shape has no envelope-level fields, so the inner
    // converter never sets `thumbnailStagedPhotoId`. This is the
    // common blog-import path where the thumbnail download is skipped.
    const out = extractedRecipeToPrefill(recipe())
    expect(out.thumbnailStagedPhotoId).toBeNull()
  })

  it('withImportEnvelope overlays a thumbnailStagedPhotoId onto the prefill', () => {
    // The wrapper has the import-DTO envelope in scope; this is the
    // seam the wrapper uses to push that field into the prefill the
    // form renders.
    const base = extractedRecipeToPrefill(recipe())
    const out = withImportEnvelope(base, {
      thumbnailStagedPhotoId: 'staged-thumb-1',
    })
    expect(out.thumbnailStagedPhotoId).toBe('staged-thumb-1')
    // All other fields round-trip unchanged so the overlay can never
    // accidentally clobber the recipe-shape conversion.
    expect(out.title).toBe(base.title)
    expect(out.ingredients).toBe(base.ingredients)
  })

  it('withImportEnvelope is a no-op when thumbnailStagedPhotoId is missing', () => {
    // A blog import that never auto-attached a thumbnail must not see
    // its prefill mutated. Pointer-equality guards against the wrapper
    // accidentally reseating arrays when nothing changed.
    const base = extractedRecipeToPrefill(recipe())
    expect(withImportEnvelope(base, {})).toBe(base)
    expect(withImportEnvelope(base, { thumbnailStagedPhotoId: null })).toBe(base)
  })

  // BUG-034 — `extractedResultToPrefill` is the outer-envelope-aware
  // sibling that also carries `recipe_empty` / `empty_reason` through.
  describe('extractedResultToPrefill (BUG-034)', () => {
    function result(over: Partial<ExtractionResult> = {}): ExtractionResult {
      return {
        recipe: recipe(),
        confidence: { overall: 'high', notes: [] },
        recipe_empty: false,
        empty_reason: null,
        ...over,
      }
    }

    it('carries recipe_empty + empty_reason onto the prefill when the gate fired', () => {
      const out = extractedResultToPrefill(
        result({
          recipe_empty: true,
          empty_reason: 'no_recipe_detected',
        }),
      )
      expect(out.recipeEmpty).toBe(true)
      expect(out.emptyReason).toBe('no_recipe_detected')
    })

    it('keeps recipeEmpty=false on a healthy extraction', () => {
      const out = extractedResultToPrefill(result())
      expect(out.recipeEmpty).toBe(false)
      expect(out.emptyReason).toBeNull()
    })

    it('defaults recipeEmpty to false when the server omitted the fields (legacy payload)', () => {
      // Cast: the legacy wire shape had no empty_gate fields; we want
      // to guarantee the frontend doesn't crash and picks the sensible
      // "not empty" default so the explainer stays dormant.
      const legacy = { recipe: recipe(), confidence: { overall: 'high', notes: [] } }
      const out = extractedResultToPrefill(legacy as unknown as ExtractionResult)
      expect(out.recipeEmpty).toBe(false)
      expect(out.emptyReason).toBeNull()
    })

    it('still forwards the inner-recipe fields (title, ingredients, …)', () => {
      const out = extractedResultToPrefill(
        result({
          recipe: recipe({
            title: 'Apfelkuchen',
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
        }),
      )
      expect(out.title).toBe('Apfelkuchen')
      expect(out.ingredients).toHaveLength(1)
      expect(out.ingredients[0]?.name).toBe('Mehl')
    })
  })
})
