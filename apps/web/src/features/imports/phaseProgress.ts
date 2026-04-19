import type { RecipeImportPhase } from '@familien-kochbuch/shared'

/**
 * Client-side mirror of the backend phase-weighted progress formula
 * (see `apps/api/src/FamilienKochbuch.Domain/Entities/RecipeImport.cs`
 * + design doc §Phase-Weighted Progress Formula). Used as a sanity
 * check + tooltip calculation only — the authoritative value still
 * comes from the SignalR payload / GET response. If they disagree,
 * trust the server.
 *
 * Weighting:
 *   Queued          → 0– 5%   (5%)
 *   Downloading     → 5–15%   (10%)
 *   Transcribing    → 15–85%  (70%)
 *   Structuring     → 85–95%  (10%)
 *   PostProcessing  → 95–100% (5%)
 *
 * Photo-path:
 *   Queued          → 0–5%
 *   VisionAnalysis  → 5–95%   (90%)
 *   PostProcessing  → 95–100%
 *
 * Terminal states (`done`, `error`) snap to 100 / the last known
 * value — callers of this helper generally branch on status before
 * reaching for a progress number.
 */

interface PhaseWeight {
  start: number
  range: number
}

/**
 * Per-phase weight table. Kept module-private + exposed via
 * {@link computeGlobalProgress} so downstream code doesn't end up with
 * divergent copies of the same numbers — every tweak to the weighting
 * must happen in exactly one place on the frontend, matching the .NET
 * `PhaseWeightedFormula`.
 */
const PHASE_WEIGHTS: Record<RecipeImportPhase, PhaseWeight> = {
  queued: { start: 0, range: 5 },
  downloading: { start: 5, range: 10 },
  // Transcribing + VisionAnalysis are the longest phases; they share the
  // "middle" slot depending on pipeline type but both should represent
  // the bulk of the progress bar so the user sees meaningful motion.
  transcribing: { start: 15, range: 70 },
  vision_analysis: { start: 5, range: 90 },
  structuring: { start: 85, range: 10 },
  post_processing: { start: 95, range: 5 },
  done: { start: 100, range: 0 },
  error: { start: 0, range: 0 },
}

/**
 * Projects a within-phase percentage (0–100) onto the global progress
 * bar for the given phase. Out-of-range values are clamped; fractional
 * results are rounded to the nearest integer to match the on-wire
 * contract (both .NET and Python serialise integer percentages).
 */
export function computeGlobalProgress(
  phase: RecipeImportPhase,
  phaseProgress: number,
): number {
  if (phase === 'done') return 100
  if (phase === 'error') return 0
  const weight = PHASE_WEIGHTS[phase]
  const clampedPhaseProgress = Math.max(0, Math.min(100, phaseProgress))
  const global = weight.start + (clampedPhaseProgress / 100) * weight.range
  return Math.round(Math.max(0, Math.min(100, global)))
}

/**
 * German-locale byte formatter. Returns "3,4 MB" / "540 KB" / "0 KB"
 * style strings with a comma decimal separator and no space-before-unit
 * surprises. Uses the 1000-base (decimal) convention — the same one
 * yt-dlp reports in its progress hook, so user-visible sizes match the
 * CLI output if the user ever checks.
 *
 * Rounding: ≥ 1 MB → one decimal, < 1 MB → integer KB.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 KB'
  if (bytes === 0) return '0 KB'
  const KB = 1000
  const MB = 1000 * 1000
  if (bytes >= MB) {
    const mb = bytes / MB
    return `${formatGermanDecimal(mb, 1)} MB`
  }
  const kb = bytes / KB
  // Below 1 KB we still show "1 KB" as the smallest meaningful unit —
  // users don't need byte-level granularity for a download progress.
  return `${Math.max(1, Math.round(kb))} KB`
}

function formatGermanDecimal(value: number, decimals: number): string {
  const fixed = value.toFixed(decimals)
  return fixed.replace('.', ',')
}

/**
 * ETA estimator for the transcription phase. Only emits a value once
 * we have enough data points to make a stable guess — below three
 * completed segments the Whisper segment-duration variance dominates,
 * producing wildly noisy numbers that are worse than no ETA at all.
 *
 * Returns a pre-formatted German string (`"noch ~45s"`) or `null` when
 * we don't trust the estimate yet.
 */
export function formatEta(
  startedAtIso: string,
  segmentsDone: number,
  segmentsTotal: number,
  nowMs?: number,
): string | null {
  if (segmentsDone <= 2) return null
  if (segmentsTotal <= 0) return null
  if (segmentsDone >= segmentsTotal) return null

  const startedMs = Date.parse(startedAtIso)
  if (Number.isNaN(startedMs)) return null

  const currentMs = nowMs ?? Date.now()
  const elapsedMs = currentMs - startedMs
  if (elapsedMs <= 0) return null

  const msPerSegment = elapsedMs / segmentsDone
  const segmentsRemaining = segmentsTotal - segmentsDone
  const etaMs = msPerSegment * segmentsRemaining
  const etaSeconds = Math.max(1, Math.round(etaMs / 1000))

  if (etaSeconds < 60) return `noch ~${etaSeconds}s`
  const etaMinutes = Math.round(etaSeconds / 60)
  return `noch ~${etaMinutes}min`
}

/**
 * German phase title used by {@link PhaseStepper} + the mobile collapsed
 * fallback. Kept in this module (rather than colocated with the
 * component) so other callers — e.g. the error toast copy — stay
 * consistent when they mention a phase by name.
 */
export function phaseLabel(phase: RecipeImportPhase): string {
  switch (phase) {
    case 'queued':
      return 'Warteschlange'
    case 'downloading':
      return 'Video-Download'
    case 'transcribing':
      return 'Transkription'
    case 'structuring':
      return 'Strukturierung'
    case 'post_processing':
      return 'Nachverarbeitung'
    case 'vision_analysis':
      return 'Foto-Analyse'
    case 'done':
      return 'Fertig'
    case 'error':
      return 'Fehler'
  }
}

/**
 * Index of the given phase in the 5-step visual stepper. The stepper
 * shows Queued → Downloading/VisionAnalysis → Transcribing/Vision →
 * Structuring → PostProcessing; the photo path folds VisionAnalysis
 * into the "middle" slot so users of either flow see the same bar
 * layout. Terminal states (done/error) stay at the last index so the
 * UI can highlight the final step while status flips.
 */
export function phaseOrder(phase: RecipeImportPhase): number {
  switch (phase) {
    case 'queued':
      return 0
    case 'downloading':
      return 1
    // VisionAnalysis sits in the same visual slot as Transcribing —
    // both flows have a "long AI-work middle" step in the stepper.
    case 'vision_analysis':
    case 'transcribing':
      return 2
    case 'structuring':
      return 3
    case 'post_processing':
      return 4
    case 'done':
      return 4
    case 'error':
      return 4
  }
}

/**
 * Ordered list of phase slots shown in the stepper. The photo-import
 * path replaces `transcribing` with `vision_analysis` in slot 2; URL
 * imports keep the Transcribing label. Exposed as a helper so
 * {@link PhaseStepper} doesn't hardcode the photo-vs-url branching.
 */
export function stepperPhases(source: 'url' | 'photos'): RecipeImportPhase[] {
  const middle: RecipeImportPhase = source === 'photos' ? 'vision_analysis' : 'transcribing'
  return ['queued', 'downloading', middle, 'structuring', 'post_processing']
}
