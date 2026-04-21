import { describe, expect, it } from 'vitest'
import type {
  ConfidenceLevel,
  EmptyReason,
  ExtractedIngredient,
  ExtractedRecipe,
  ExtractedStep,
  ExtractionConfidence,
  ExtractionResult,
  ExtractionSignals,
  ImportEnqueueResponse,
  ImportSourceKind,
  ImportStatus,
  ImportSummaryDto,
  ImportUrlRequest,
  IngredientConfidenceLevel,
  RecipeImportDto,
  StepConfidenceLevel,
} from './imports.ts'

/**
 * These are type-level regression tests — they exist so a breaking
 * rename on the DTO surface fails in CI alongside the .NET side
 * (`ImportEndpoints.ImportStatusResponse`) and the Python side
 * (`extractor.pipeline.types.ExtractionResult`). Runtime behaviour
 * in this file is intentionally trivial; the failure mode is at
 * `tsc` / `vitest --run`'s type-check pass.
 */

describe('imports.ts DTOs', () => {
  it('ImportStatus covers all four wire values (lowercased)', () => {
    const values: ImportStatus[] = ['queued', 'running', 'done', 'error']
    expect(values).toHaveLength(4)
  })

  it('ImportSourceKind covers all three wire values', () => {
    const values: ImportSourceKind[] = ['url', 'photos', 'chat']
    expect(values).toHaveLength(3)
  })

  it('IngredientConfidenceLevel includes "missing" and "handwritten_uncertain"', () => {
    const levels: IngredientConfidenceLevel[] = [
      'high',
      'medium',
      'low',
      'missing',
      'handwritten_uncertain',
    ]
    expect(levels).toHaveLength(5)
  })

  it('StepConfidenceLevel widens ConfidenceLevel with "handwritten_uncertain"', () => {
    const base: ConfidenceLevel = 'high'
    const widened: StepConfidenceLevel = 'handwritten_uncertain'
    // Assignment direction: every base confidence level is a valid step level.
    const asStep: StepConfidenceLevel = base
    expect([asStep, widened]).toHaveLength(2)
  })

  it('ImportUrlRequest has url + groupId (both strings)', () => {
    const req: ImportUrlRequest = {
      url: 'https://www.chefkoch.de/rezepte/123/Pizza.html',
      groupId: '11111111-2222-3333-4444-555555555555',
    }
    expect(req.url).toContain('https')
    expect(req.groupId).toContain('-')
  })

  it('ImportEnqueueResponse has importId', () => {
    const res: ImportEnqueueResponse = {
      importId: '11111111-2222-3333-4444-555555555555',
    }
    expect(res.importId).toBeTypeOf('string')
  })

  it('ExtractedIngredient supports null quantity/unit/note + confidence', () => {
    const ing: ExtractedIngredient = {
      name: 'Mehl',
      quantity: null,
      unit: null,
      note: null,
      confidence: 'missing',
    }
    expect(ing.name).toBe('Mehl')
    expect(ing.quantity).toBeNull()
  })

  it('ExtractedStep has 1-indexed position + content + confidence', () => {
    const step: ExtractedStep = {
      position: 1,
      content: 'Ofen vorheizen.',
      confidence: 'high',
    }
    expect(step.position).toBe(1)
  })

  it('ExtractedRecipe carries components, tags, source_url, thumbnail_url', () => {
    const recipe: ExtractedRecipe = {
      title: 'Omas Apfelkuchen',
      description: null,
      servings: 4,
      difficulty: null,
      prep_minutes: null,
      cook_minutes: null,
      components: [
        { label: null, position: 0, ingredients: [], steps: [] },
      ],
      tags: ['backen'],
      source_url: 'https://example.com/apfelkuchen',
      thumbnail_url: null,
    }
    expect(recipe.tags).toContain('backen')
    expect(recipe.components).toHaveLength(1)
  })

  it('ExtractionResult wraps recipe + confidence + empty-gate fields', () => {
    const confidence: ExtractionConfidence = { overall: 'high', notes: [] }
    const result: ExtractionResult = {
      recipe: {
        title: 'T',
        description: null,
        servings: null,
        difficulty: null,
        prep_minutes: null,
        cook_minutes: null,
        components: [
          { label: null, position: 0, ingredients: [], steps: [] },
        ],
        tags: [],
        source_url: 'https://example.com',
        thumbnail_url: null,
      },
      confidence,
      recipe_empty: false,
      empty_reason: null,
      signals: {
        had_caption_url: false,
        had_blog_source: false,
        had_transcript: false,
      },
    }
    expect(result.confidence.overall).toBe('high')
    expect(result.recipe_empty).toBe(false)
    expect(result.empty_reason).toBeNull()
  })

  // BUG-034 — empty-extraction flag round-trips through JSON serialise/
  // deserialise, the wire format between Python (snake_case) and the
  // frontend mirror in this file. The .NET bridge forwards `ResultJson`
  // opaquely, so a structural rename on either side would surface here.
  it('BUG-034: ExtractionResult round-trips recipe_empty + empty_reason via JSON', () => {
    const reasons: EmptyReason[] = [
      'no_recipe_detected',
      'no_usable_source',
      'empty_transcript',
      'extractor_error',
    ]
    expect(reasons).toHaveLength(4)

    const source: ExtractionResult = {
      recipe: {
        title: 'Unbekanntes Rezept',
        description: null,
        servings: null,
        difficulty: null,
        prep_minutes: null,
        cook_minutes: null,
        components: [
          { label: null, position: 0, ingredients: [], steps: [] },
        ],
        tags: [],
        source_url: 'https://facebook.com/share/r/xyz',
        thumbnail_url: null,
      },
      confidence: { overall: 'low', notes: [] },
      recipe_empty: true,
      empty_reason: 'no_recipe_detected',
      signals: {
        had_caption_url: false,
        had_blog_source: false,
        had_transcript: true,
      },
    }
    const wire = JSON.stringify(source)
    const parsed = JSON.parse(wire) as ExtractionResult
    expect(parsed.recipe_empty).toBe(true)
    expect(parsed.empty_reason).toBe('no_recipe_detected')
    expect(parsed.recipe.components).toHaveLength(1)
    expect(parsed.recipe.components[0]?.ingredients).toEqual([])
    expect(parsed.recipe.components[0]?.steps).toEqual([])
    expect(parsed.signals.had_transcript).toBe(true)
    expect(parsed.signals.had_caption_url).toBe(false)
    expect(parsed.signals.had_blog_source).toBe(false)
  })

  // BUG-034 (signal-aware follow-up) — three boolean signal flags let
  // the frontend render a signal-aware German explainer. Drift guard:
  // a rename on the Python TypedDict triggers the .NET bridge +
  // frontend mirror to shift in lockstep.
  it('BUG-034: ExtractionSignals shape pins the three boolean flags', () => {
    const signals: ExtractionSignals = {
      had_caption_url: true,
      had_blog_source: false,
      had_transcript: true,
    }
    expect(signals.had_caption_url).toBe(true)
    expect(signals.had_blog_source).toBe(false)
    expect(signals.had_transcript).toBe(true)
  })

  it('BUG-034: no_usable_source is a valid EmptyReason literal', () => {
    const reason: EmptyReason = 'no_usable_source'
    expect(reason).toBe('no_usable_source')
  })

  it('RecipeImportDto carries the full status shape the client exposes', () => {
    const dto: RecipeImportDto = {
      id: '11111111-2222-3333-4444-555555555555',
      groupId: '22222222-3333-4444-5555-666666666666',
      source: 'url',
      status: 'running',
      progress: 42,
      sourceUrl: 'https://example.com',
      result: null,
      errorMessage: null,
      createdAt: '2026-04-18T00:00:00Z',
      completedAt: null,
    }
    expect(dto.status).toBe('running')
    expect(dto.progress).toBe(42)
    expect(dto.result).toBeNull()
  })

  // PV4 regression — `groupId` is now a required field on the DTO so
  // the polling fallback carries the redirect target (resolves BUG-012).
  it('RecipeImportDto requires groupId on the DTO surface', () => {
    const dto: RecipeImportDto = {
      id: '11111111-2222-3333-4444-555555555555',
      groupId: '22222222-3333-4444-5555-666666666666',
      source: 'url',
      status: 'done',
      progress: 100,
      sourceUrl: 'https://example.com',
      result: null,
      errorMessage: null,
      createdAt: '2026-04-18T00:00:00Z',
      completedAt: '2026-04-18T00:00:05Z',
    }
    expect(dto.groupId).toBe('22222222-3333-4444-5555-666666666666')
  })

  // REIMPORT-0 — the in-place reimport flow extends the DTO with an
  // optional `targetRecipeId`. The web layer's progress-page uses the
  // field to branch between "Done → new recipe form" (null) and
  // "Done → back to detail page" (set). A rename on the .NET
  // ImportStatusResponse record fails this compile-time gate.
  it('RecipeImportDto carries optional targetRecipeId for reimports', () => {
    const reimport: RecipeImportDto = {
      id: '11111111-2222-3333-4444-555555555555',
      groupId: '22222222-3333-4444-5555-666666666666',
      source: 'url',
      status: 'done',
      progress: 100,
      sourceUrl: 'https://example.com/rezept',
      result: null,
      errorMessage: null,
      createdAt: '2026-04-21T00:00:00Z',
      completedAt: '2026-04-21T00:00:42Z',
      targetRecipeId: '33333333-4444-5555-6666-777777777777',
    }
    expect(reimport.targetRecipeId).toBe('33333333-4444-5555-6666-777777777777')

    // A non-reimport row leaves the field null / omitted — both shapes
    // must type-check against the same interface.
    const newImport: RecipeImportDto = {
      id: '11111111-2222-3333-4444-555555555555',
      groupId: '22222222-3333-4444-5555-666666666666',
      source: 'url',
      status: 'running',
      progress: 50,
      sourceUrl: 'https://example.com/rezept',
      result: null,
      errorMessage: null,
      createdAt: '2026-04-21T00:00:00Z',
      completedAt: null,
      targetRecipeId: null,
    }
    expect(newImport.targetRecipeId).toBeNull()
  })

  // BUG-010 — compile-time regression guard on the list-DTO surface.
  // A rename on the .NET ImportSummary record fails here if the shared
  // type drifts away.
  it('ImportSummaryDto carries the list-item fields the UI consumes', () => {
    const summary: ImportSummaryDto = {
      id: '11111111-2222-3333-4444-555555555555',
      groupId: '22222222-3333-4444-5555-666666666666',
      source: 'url',
      status: 'running',
      progress: 42,
      phase: 'transcribing',
      progressLabel: 'Audio wird transkribiert',
      sourceUrl: 'https://example.com',
      createdAt: '2026-04-18T00:00:00Z',
      completedAt: null,
      errorMessage: null,
    }
    expect(summary.phase).toBe('transcribing')
    expect(summary.status).toBe('running')
    expect(summary.completedAt).toBeNull()
  })
})
