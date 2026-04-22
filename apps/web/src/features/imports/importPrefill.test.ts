import { describe, expect, it } from 'vitest'
import type { ExtractedRecipe, ExtractionResult } from '@familien-kochbuch/shared'
import {
  extractedRecipeToPrefill,
  extractedResultToPrefill,
  withImportEnvelope,
} from './importPrefill'

/**
 * COMP-2 helper — build an ExtractedRecipe with a single default
 * component (label:null, position:0) that carries the caller's
 * ingredients/steps. Lets the existing per-field tests stay focused
 * on one dimension without re-writing the whole fixture each time.
 */
function recipe(
  over: Partial<
    Omit<ExtractedRecipe, 'components'> & {
      ingredients?: ExtractedRecipe['components'][number]['ingredients']
      steps?: ExtractedRecipe['components'][number]['steps']
      components?: ExtractedRecipe['components']
    }
  > = {},
): ExtractedRecipe {
  const { ingredients, steps, components, ...rest } = over
  const resolvedComponents =
    components ??
    [
      {
        label: null,
        position: 0,
        ingredients: ingredients ?? [],
        steps: steps ?? [],
      },
    ]
  return {
    title: 'Pizza',
    description: null,
    servings: null,
    difficulty: null,
    prep_minutes: null,
    cook_minutes: null,
    components: resolvedComponents,
    tags: [],
    source_url: 'https://example.com',
    thumbnail_url: null,
    ...rest,
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
    expect(out.components[0]?.ingredients[0]).toMatchObject({
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
    expect(out.components[0]?.ingredients[0]?.quantity).toBe('500')
    expect(out.components[0]?.ingredients[0]?.scalable).toBe(true)
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
    expect(out.components[0]?.ingredients[0]?.unit).toBe('ml')
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
    expect(out.components[0]?.ingredients[0]?.unit).toBe('g')
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
    expect(out.components[0]?.ingredients[0]?.confidence).toBe('handwritten_uncertain')
    expect(out.components[0]?.steps[0]?.confidence).toBe('handwritten_uncertain')
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
    expect(out.components).toBe(base.components)
  })

  it('withImportEnvelope is a no-op when thumbnailStagedPhotoId is missing', () => {
    // A blog import that never auto-attached a thumbnail must not see
    // its prefill mutated. Pointer-equality guards against the wrapper
    // accidentally reseating arrays when nothing changed.
    const base = extractedRecipeToPrefill(recipe())
    expect(withImportEnvelope(base, {})).toBe(base)
    expect(withImportEnvelope(base, { thumbnailStagedPhotoId: null })).toBe(base)
  })

  // ── COVER-0 (Slice D) — candidateStagedPhotoIds passthrough ─────
  //
  // The import DTO now carries a full candidate array — up to 6 ids the
  // URL-extract job captured (yt-dlp thumbnails + ffmpeg frames +
  // JSON-LD image[]). The prefill must surface the whole list so the
  // form can render the 3×2 picker grid; legacy imports that only set
  // the singleton `thumbnailStagedPhotoId` get a one-tile fallback so
  // pre-Slice-B rows keep rendering until the TTL sweep reaps them.

  it('defaults candidateStagedPhotoIds to [] when no envelope is supplied', () => {
    const out = extractedRecipeToPrefill(recipe())
    expect(out.candidateStagedPhotoIds).toEqual([])
  })

  it('withImportEnvelope overlays a 6-candidate array onto the prefill', () => {
    const base = extractedRecipeToPrefill(recipe())
    const ids = ['sp-0', 'sp-1', 'sp-2', 'sp-3', 'sp-4', 'sp-5']
    const out = withImportEnvelope(base, { candidateStagedPhotoIds: ids })
    expect(out.candidateStagedPhotoIds).toEqual(ids)
    // Also folds the cover-mirror into the legacy singleton so code
    // paths that still read `thumbnailStagedPhotoId` keep working
    // during the migration window (Slice B contract).
    expect(out.thumbnailStagedPhotoId).toBe('sp-0')
  })

  it('withImportEnvelope legacy fallback: empty candidate array + thumbnailStagedPhotoId set → derives a one-element candidate array', () => {
    // Legacy rows (pre-Slice-B deploy) only set thumbnailStagedPhotoId;
    // the prefill must synthesise a single-element candidates array so
    // the form's picker always reads from one source of truth.
    const base = extractedRecipeToPrefill(recipe())
    const out = withImportEnvelope(base, {
      candidateStagedPhotoIds: [],
      thumbnailStagedPhotoId: 'legacy-thumb',
    })
    expect(out.candidateStagedPhotoIds).toEqual(['legacy-thumb'])
    expect(out.thumbnailStagedPhotoId).toBe('legacy-thumb')
  })

  it('withImportEnvelope no candidates + no thumbnail → empty array, no fallback tile', () => {
    // Blog imports that never attached any cover candidate must not
    // invent a tile out of thin air — the picker UI stays dormant
    // when the array is empty.
    const base = extractedRecipeToPrefill(recipe())
    const out = withImportEnvelope(base, {
      candidateStagedPhotoIds: [],
      thumbnailStagedPhotoId: null,
    })
    expect(out.candidateStagedPhotoIds).toEqual([])
    expect(out.thumbnailStagedPhotoId).toBeNull()
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
        signals: {
          had_caption_url: false,
          had_blog_source: false,
          had_transcript: false,
        },
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
      expect(out.components).toHaveLength(1)
      expect(out.components[0]?.ingredients).toHaveLength(1)
      expect(out.components[0]?.ingredients[0]?.name).toBe('Mehl')
    })

    // BUG-034 (signal-aware follow-up) — the three signal flags flow
    // from `ExtractionResult.signals` onto the prefill so the wrapper
    // can hand them to `EmptyExtractionExplainer` for variant copy.
    it('carries ExtractionResult.signals onto the prefill', () => {
      const out = extractedResultToPrefill(
        result({
          recipe_empty: true,
          empty_reason: 'no_recipe_detected',
          signals: {
            had_caption_url: true,
            had_blog_source: false,
            had_transcript: true,
          },
        }),
      )
      expect(out.signals).toEqual({
        had_caption_url: true,
        had_blog_source: false,
        had_transcript: true,
      })
    })

    it('defaults signals to all-false when the server omitted them (legacy payload)', () => {
      // Legacy payload + signal-aware explainer branch: when the field
      // is missing, default to "all sources empty" so the explainer
      // doesn't claim we had signals we didn't actually capture.
      const legacy = { recipe: recipe(), confidence: { overall: 'high', notes: [] } }
      const out = extractedResultToPrefill(legacy as unknown as ExtractionResult)
      expect(out.signals).toEqual({
        had_caption_url: false,
        had_blog_source: false,
        had_transcript: false,
      })
    })
  })

  // ── COMP-2 — nested components round-trip ────────────────────────
  describe('COMP-2 nested components', () => {
    it('maps a multi-component ExtractedRecipe into the prefill.components array preserving labels + children', () => {
      const out = extractedRecipeToPrefill(
        recipe({
          components: [
            {
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
            },
            {
              label: null,
              position: 1,
              ingredients: [
                {
                  name: 'Tortilla',
                  quantity: '1',
                  unit: 'Stück',
                  note: null,
                  confidence: 'high',
                },
              ],
              steps: [
                { position: 1, content: 'Anbraten.', confidence: 'high' },
              ],
            },
          ],
        }),
      )
      expect(out.components).toHaveLength(2)
      expect(out.components[0]?.label).toBe('Chipotle Sauce')
      expect(out.components[0]?.position).toBe(0)
      expect(out.components[0]?.ingredients[0]?.name).toBe('Honig')
      expect(out.components[1]?.label).toBeNull()
      expect(out.components[1]?.ingredients[0]?.name).toBe('Tortilla')
    })

    it('single-default fallback: one component with label=null when the wire carries exactly one null-labelled entry', () => {
      const out = extractedRecipeToPrefill(
        recipe({
          components: [
            {
              label: null,
              position: 0,
              ingredients: [
                {
                  name: 'Mehl',
                  quantity: '500',
                  unit: 'g',
                  note: null,
                  confidence: 'high',
                },
              ],
              steps: [
                { position: 1, content: 'Kneten.', confidence: 'high' },
              ],
            },
          ],
        }),
      )
      expect(out.components).toHaveLength(1)
      expect(out.components[0]?.label).toBeNull()
      expect(out.components[0]?.ingredients[0]?.name).toBe('Mehl')
    })

    it('renumbers component positions 0..n-1 regardless of the LLM emit order (defensive normalisation)', () => {
      const out = extractedRecipeToPrefill(
        recipe({
          components: [
            { label: 'A', position: 5, ingredients: [], steps: [] },
            { label: 'B', position: 2, ingredients: [], steps: [] },
          ],
        }),
      )
      expect(out.components.map((c) => c.position)).toEqual([0, 1])
    })

    it('falls back to a single default component when the legacy wire lacks components', () => {
      // Defensive: chat-import payloads (or tests predating COMP-1) may
      // arrive without the `components` key at all. The prefill must
      // still emerge with at least one component so the form renders.
      const legacy = {
        title: 'Legacy',
        description: null,
        servings: null,
        difficulty: null,
        prep_minutes: null,
        cook_minutes: null,
        tags: [],
        source_url: 'https://example.com',
        thumbnail_url: null,
      } as unknown as ExtractedRecipe
      const out = extractedRecipeToPrefill(legacy)
      expect(out.components).toHaveLength(1)
      expect(out.components[0]?.label).toBeNull()
      expect(out.components[0]?.ingredients).toEqual([])
      expect(out.components[0]?.steps).toEqual([])
    })
  })
})
