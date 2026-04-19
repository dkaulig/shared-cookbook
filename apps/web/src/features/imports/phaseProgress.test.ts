import { describe, expect, it } from 'vitest'
import type { RecipeImportPhase } from '@familien-kochbuch/shared'
import {
  derivePhase,
  formatBytes,
  formatEta,
  phaseLabel,
  phaseOrder,
  resolveLabel,
  stepperPhases,
} from './phaseProgress'

describe('formatBytes', () => {
  it.each<[number, string]>([
    [0, '0 KB'],
    [500, '1 KB'],
    [1000, '1 KB'],
    [540_000, '540 KB'],
    [999_000, '999 KB'],
    [1_000_000, '1,0 MB'],
    [3_400_000, '3,4 MB'],
    [12_700_000, '12,7 MB'],
    [100_000_000, '100,0 MB'],
  ])('formats %d bytes as "%s"', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected)
  })

  it('returns "0 KB" for non-finite input (defensive against NaN payloads)', () => {
    expect(formatBytes(Number.NaN)).toBe('0 KB')
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 KB')
  })

  it('returns "0 KB" for negative input rather than "-1 KB"', () => {
    expect(formatBytes(-500)).toBe('0 KB')
  })
})

describe('formatEta', () => {
  const startedAt = '2026-04-19T12:00:00Z'
  // 20s wall-clock into the phase — deterministic "now" for ETA math.
  const nowMs = Date.parse('2026-04-19T12:00:20Z')

  it('returns null when fewer than 3 segments have completed', () => {
    expect(formatEta(startedAt, 0, 20, nowMs)).toBeNull()
    expect(formatEta(startedAt, 1, 20, nowMs)).toBeNull()
    expect(formatEta(startedAt, 2, 20, nowMs)).toBeNull()
  })

  it('returns null when all segments are already done', () => {
    expect(formatEta(startedAt, 20, 20, nowMs)).toBeNull()
  })

  it('returns null when segmentsTotal is not positive', () => {
    expect(formatEta(startedAt, 10, 0, nowMs)).toBeNull()
    expect(formatEta(startedAt, 10, -1, nowMs)).toBeNull()
  })

  it('returns null when startedAt is unparseable', () => {
    expect(formatEta('not-a-date', 5, 20, nowMs)).toBeNull()
  })

  it('returns null when elapsed time is zero or negative', () => {
    const zeroMs = Date.parse(startedAt)
    expect(formatEta(startedAt, 5, 20, zeroMs)).toBeNull()
    expect(formatEta(startedAt, 5, 20, zeroMs - 1000)).toBeNull()
  })

  it('formats ETA in seconds when under a minute', () => {
    // 3 segments in 20s → 1 remaining ≈ 6-7s. 20 - 3 = 17 remaining,
    // 20s / 3 segments ≈ 6.67s each → 17 * 6.67 ≈ 113s → 2min
    // Use a tighter fixture: 5 done / 10 total in 20s → 20/5*5 = 20s.
    expect(formatEta(startedAt, 5, 10, nowMs)).toBe('noch ~20s')
  })

  it('formats ETA in minutes when over a minute', () => {
    // 3 done / 20 total in 20s → 20/3 ≈ 6.67 * 17 ≈ 113s ≈ 2min.
    expect(formatEta(startedAt, 3, 20, nowMs)).toBe('noch ~2min')
  })
})

describe('phaseLabel', () => {
  it.each<[RecipeImportPhase, string]>([
    ['queued', 'Warteschlange'],
    ['downloading', 'Video-Download'],
    ['transcribing', 'Transkription'],
    ['structuring', 'Strukturierung'],
    ['post_processing', 'Nachverarbeitung'],
    ['vision_analysis', 'Foto-Analyse'],
    ['done', 'Fertig'],
    ['error', 'Fehler'],
  ])('maps phase %s → "%s"', (phase, expected) => {
    expect(phaseLabel(phase)).toBe(expected)
  })
})

describe('phaseOrder', () => {
  it.each<[RecipeImportPhase, number]>([
    ['queued', 0],
    ['downloading', 1],
    ['transcribing', 2],
    ['vision_analysis', 2],
    ['structuring', 3],
    ['post_processing', 4],
    // PV3 simplification: terminal states map OUTSIDE the in-progress
    // stepper range so the UI can distinguish "post_processing running"
    // from "all steps done". `done` → past-final, `error` → sentinel.
    ['done', 5],
    ['error', -1],
  ])('maps phase %s → index %d', (phase, expected) => {
    expect(phaseOrder(phase)).toBe(expected)
  })
})

describe('stepperPhases', () => {
  it('URL import: Queued → Downloading → Transcribing → Structuring → PostProcessing', () => {
    expect(stepperPhases('url')).toEqual([
      'queued',
      'downloading',
      'transcribing',
      'structuring',
      'post_processing',
    ])
  })

  it('Photo import: swaps Transcribing slot for VisionAnalysis', () => {
    expect(stepperPhases('photos')).toEqual([
      'queued',
      'downloading',
      'vision_analysis',
      'structuring',
      'post_processing',
    ])
  })
})

// PV3 simplification: these helpers moved from ImportProgressPage.tsx —
// co-locating with the other phase helpers keeps all phase routing in a
// single module and gives the page a single import.
describe('derivePhase', () => {
  it('returns queued when no data is available (pre-first-poll)', () => {
    expect(derivePhase(undefined)).toBe('queued')
  })

  it('prefers the server-supplied phase field', () => {
    expect(
      derivePhase({
        id: 'i1',
        groupId: 'g1',
        source: 'url',
        status: 'running',
        progress: 50,
        sourceUrl: null,
        result: null,
        errorMessage: null,
        createdAt: '2026-04-19T12:00:00Z',
        completedAt: null,
        phase: 'transcribing',
      }),
    ).toBe('transcribing')
  })

  it('falls back to a coarse phase from status when phase is absent', () => {
    const base = {
      id: 'i1',
      groupId: 'g1',
      source: 'url' as const,
      progress: 0,
      sourceUrl: null,
      result: null,
      errorMessage: null,
      createdAt: '2026-04-19T12:00:00Z',
      completedAt: null,
    }
    expect(derivePhase({ ...base, status: 'done' })).toBe('done')
    expect(derivePhase({ ...base, status: 'error' })).toBe('error')
    expect(derivePhase({ ...base, status: 'queued' })).toBe('queued')
    // Running without phase → assume the longest phase so the user sees
    // meaningful copy.
    expect(derivePhase({ ...base, status: 'running' })).toBe('transcribing')
  })
})

describe('resolveLabel', () => {
  it('returns the server-supplied progressLabel verbatim when present', () => {
    expect(
      resolveLabel(
        {
          id: 'i1',
          groupId: 'g1',
          source: 'url',
          status: 'running',
          progress: 45,
          sourceUrl: null,
          result: null,
          errorMessage: null,
          createdAt: '2026-04-19T12:00:00Z',
          completedAt: null,
          progressLabel: 'Audio wird transkribiert',
        },
        'running',
      ),
    ).toBe('Audio wird transkribiert')
  })

  it('falls back to the queued label when no data is available', () => {
    expect(resolveLabel(undefined, 'loading')).toMatch(/warteschlange/i)
  })

  it('falls back to the legacy progressLabel helper when server field is missing', () => {
    expect(
      resolveLabel(
        {
          id: 'i1',
          groupId: 'g1',
          source: 'url',
          status: 'running',
          progress: 45,
          sourceUrl: null,
          result: null,
          errorMessage: null,
          createdAt: '2026-04-19T12:00:00Z',
          completedAt: null,
        },
        'running',
      ),
    ).toMatch(/transkribieren/i)
  })
})
