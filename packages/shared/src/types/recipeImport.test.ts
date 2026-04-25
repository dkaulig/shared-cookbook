import { describe, expect, it } from 'vitest'
import {
  RECIPE_IMPORT_PHASES,
  type RecipeImportPhase,
  type RecipeImportProgressEventPayload,
} from './recipeImport.ts'

/**
 * Type-level + shape regression tests for the PV3 shared types. The
 * `RecipeImportPhase` union mirrors the .NET `RecipeImportPhaseWire`
 * output (see `apps/api/src/SharedCookbook.Api/Hubs/LiveSyncPublisher.cs`)
 * and the Python extractor's callback body. Breaking the alignment
 * here is a coordination bug; these tests fail on `vitest --run`'s
 * type-check pass before the UI even starts rendering.
 */

describe('recipeImport.ts DTOs', () => {
  it('RECIPE_IMPORT_PHASES enumerates all eight snake-case wire values', () => {
    expect(RECIPE_IMPORT_PHASES).toEqual([
      'queued',
      'downloading',
      'transcribing',
      'structuring',
      'post_processing',
      'vision_analysis',
      'done',
      'error',
    ])
  })

  it('each entry of RECIPE_IMPORT_PHASES is assignable to RecipeImportPhase', () => {
    // Compile-time assertion encoded at runtime: every tuple entry must
    // be assignable to the union, which would otherwise fail `tsc`.
    const phases: RecipeImportPhase[] = [...RECIPE_IMPORT_PHASES]
    expect(phases).toHaveLength(8)
  })

  it('RecipeImportProgressEventPayload carries the PV1 SignalR shape', () => {
    const payload: RecipeImportProgressEventPayload = {
      importId: '11111111-2222-3333-4444-555555555555',
      groupId: '22222222-3333-4444-5555-666666666666',
      phase: 'downloading',
      progress: 10,
      phaseProgress: 50,
      progressLabel: 'Video wird heruntergeladen',
      attemptNumber: 1,
      bytesDownloaded: 3_400_000,
      bytesTotal: 12_700_000,
      segmentsDone: null,
      segmentsTotal: null,
    }
    expect(payload.phase).toBe('downloading')
    expect(payload.bytesDownloaded).toBe(3_400_000)
    expect(payload.segmentsDone).toBeNull()
  })

  it('RecipeImportProgressEventPayload allows omitting byte/segment counters', () => {
    // Structuring / post_processing / vision_analysis events send neither
    // byte nor segment counters — the optional fields MUST be allowed
    // to be absent entirely, not just nullable.
    const payload: RecipeImportProgressEventPayload = {
      importId: '11111111-2222-3333-4444-555555555555',
      groupId: '22222222-3333-4444-5555-666666666666',
      phase: 'structuring',
      progress: 90,
      phaseProgress: 50,
      progressLabel: 'Rezept wird strukturiert (Azure OpenAI)',
      attemptNumber: 2,
    }
    expect(payload.bytesDownloaded).toBeUndefined()
    expect(payload.segmentsDone).toBeUndefined()
  })
})
