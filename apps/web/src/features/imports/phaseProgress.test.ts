import { describe, expect, it } from 'vitest'
import type { RecipeImportPhase } from '@familien-kochbuch/shared'
import {
  computeGlobalProgress,
  formatBytes,
  formatEta,
  phaseLabel,
  phaseOrder,
  stepperPhases,
} from './phaseProgress'

describe('computeGlobalProgress', () => {
  // Exhaustive cases mirroring the .NET `PhaseWeightedFormula` table. If
  // any of these drift, the client is disagreeing with the server — a
  // design-anchor violation explicitly called out in the plan.
  it.each<[RecipeImportPhase, number, number]>([
    ['queued', 0, 0],
    ['queued', 100, 5],
    ['downloading', 0, 5],
    ['downloading', 50, 10],
    ['downloading', 100, 15],
    ['transcribing', 0, 15],
    ['transcribing', 50, 50],
    ['transcribing', 100, 85],
    ['structuring', 0, 85],
    ['structuring', 100, 95],
    ['post_processing', 0, 95],
    ['post_processing', 100, 100],
    ['vision_analysis', 0, 5],
    ['vision_analysis', 50, 50],
    ['vision_analysis', 100, 95],
  ])('maps (%s, %d) → %d global%%', (phase, phaseProgress, expected) => {
    expect(computeGlobalProgress(phase, phaseProgress)).toBe(expected)
  })

  it('clamps a negative within-phase value to 0', () => {
    expect(computeGlobalProgress('downloading', -10)).toBe(5)
  })

  it('clamps an over-100 within-phase value to 100', () => {
    expect(computeGlobalProgress('downloading', 250)).toBe(15)
  })

  it('returns 100 for the Done phase regardless of within-phase value', () => {
    expect(computeGlobalProgress('done', 0)).toBe(100)
    expect(computeGlobalProgress('done', 42)).toBe(100)
  })

  it('returns 0 for the Error phase (progress bar no longer meaningful)', () => {
    expect(computeGlobalProgress('error', 0)).toBe(0)
    expect(computeGlobalProgress('error', 80)).toBe(0)
  })
})

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
    ['done', 4],
    ['error', 4],
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
