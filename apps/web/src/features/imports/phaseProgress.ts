import type { ImportStatus, RecipeImportDto, RecipeImportPhase } from '@familien-kochbuch/shared'
import { progressLabel } from './progressLabel'

/**
 * Phase helpers shared between `ImportProgressPage`, `PhaseStepper` and
 * friends. The phase-weighted formula itself lives on the server (see
 * `apps/api/src/FamilienKochbuch.Domain/Entities/RecipeImport.cs` +
 * design doc §Phase-Weighted Progress Formula). We deliberately keep
 * the client free of a parallel implementation — every SignalR payload
 * and GET response carries the authoritative `progress` field, and
 * duplicating the table on the frontend would just create a drift risk
 * without any visible UX win.
 */

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
 * layout.
 *
 * Terminal states map OUTSIDE the in-progress range so the stepper can
 * distinguish "post-processing is currently running" from "all five
 * steps are completed":
 *   - `done`  → 5 (past-final, every step renders as completed)
 *   - `error` → -1 (outside stepper; UI draws an error marker on the
 *     last-active phase via a separate `attemptedPhase` lookup)
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
    // Past-final — all in-stepper slots (0..4) render as completed.
    case 'done':
      return 5
    // Outside the stepper; caller branches on this to render an error
    // marker rather than positioning a "current" dot on slot 4.
    case 'error':
      return -1
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

/**
 * Picks the best phase to render the UI with. Prefers the explicit
 * server-supplied `phase` field (populated by SignalR or, once backend
 * exposes it, the GET response); falls back to deriving a coarse phase
 * from `status` so the page stays coherent before the first phase-aware
 * payload lands.
 *
 * Co-located with the other phase helpers so the `ImportProgressPage`
 * render path has a single import instead of two inline functions.
 */
export function derivePhase(data: RecipeImportDto | undefined): RecipeImportPhase {
  if (!data) return 'queued'
  if (data.phase) return data.phase
  if (data.status === 'done') return 'done'
  if (data.status === 'error') return 'error'
  if (data.status === 'queued') return 'queued'
  // Running with no phase info — assume the longest phase so the user
  // sees meaningful copy instead of a stuck "Queued".
  return 'transcribing'
}

/**
 * Resolves the label shown next to the global-progress percent. Prefers
 * the server-computed `progressLabel` (PV1 added this field on every
 * SignalR payload); falls back to the legacy `progressLabel()` helper
 * for a loading/first-render state where the server copy isn't
 * available yet.
 */
export function resolveLabel(
  data: RecipeImportDto | undefined,
  effectiveStatus: ImportStatus | 'loading',
): string {
  if (data?.progressLabel) return data.progressLabel
  if (!data) return progressLabel('queued', 0)
  return progressLabel(
    effectiveStatus === 'loading' ? 'queued' : effectiveStatus,
    data.progress ?? 0,
  )
}
