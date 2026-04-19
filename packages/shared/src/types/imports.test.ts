import { describe, expect, it } from 'vitest'
import type {
  ConfidenceLevel,
  ExtractedIngredient,
  ExtractedRecipe,
  ExtractedStep,
  ExtractionConfidence,
  ExtractionResult,
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

  it('ExtractedRecipe carries ingredients, steps, tags, source_url, thumbnail_url', () => {
    const recipe: ExtractedRecipe = {
      title: 'Omas Apfelkuchen',
      description: null,
      servings: 4,
      difficulty: null,
      prep_minutes: null,
      cook_minutes: null,
      ingredients: [],
      steps: [],
      tags: ['backen'],
      source_url: 'https://example.com/apfelkuchen',
      thumbnail_url: null,
    }
    expect(recipe.tags).toContain('backen')
  })

  it('ExtractionResult wraps recipe + confidence', () => {
    const confidence: ExtractionConfidence = { overall: 'high', notes: [] }
    const result: ExtractionResult = {
      recipe: {
        title: 'T',
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
      },
      confidence,
    }
    expect(result.confidence.overall).toBe('high')
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
