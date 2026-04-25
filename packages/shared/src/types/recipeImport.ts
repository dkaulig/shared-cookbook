/**
 * PV3 — phase-aware import progress types.
 *
 * Complements {@link ./imports.ts} with the fields introduced by the
 * video-import progress tracking redesign (see
 * `docs/plans/2026-04-19-video-import-progress-design.md`). The existing
 * {@link RecipeImportDto} in `imports.ts` is extended with the new phase
 * fields; this file exports the standalone {@link RecipeImportPhase}
 * union + the SignalR progress event payload type so a downstream
 * consumer never has to reach into the larger imports module when it
 * only needs phase metadata.
 *
 * Wire contract:
 *   - `.NET` `RecipeImportPhaseWire.ToWire(phase)` (see
 *     `apps/api/src/SharedCookbook.Api/Hubs/LiveSyncPublisher.cs`)
 *     emits the snake-case strings below.
 *   - Python `ProgressReporter` uses the same snake-case form when it
 *     posts `POST /api/internal/imports/{id}/progress`.
 *   - Both the GET `/api/imports/:id` wire (once backend exposes the
 *     fields — currently the GET endpoint still serialises only the
 *     legacy subset) and the SignalR `RecipeImportProgressChanged`
 *     payload use this union directly.
 */

export type RecipeImportPhase =
  | 'queued'
  | 'downloading'
  | 'transcribing'
  | 'structuring'
  | 'post_processing'
  | 'vision_analysis'
  | 'done'
  | 'error'

/**
 * Snake-case wire values for {@link RecipeImportPhase}. Exported as a
 * frozen tuple so consumers can iterate (e.g. exhaustive tests) without
 * re-declaring the list.
 */
export const RECIPE_IMPORT_PHASES = [
  'queued',
  'downloading',
  'transcribing',
  'structuring',
  'post_processing',
  'vision_analysis',
  'done',
  'error',
] as const satisfies readonly RecipeImportPhase[]

/**
 * SignalR `RecipeImportProgressChanged` payload. Matches the .NET
 * `RecipeImportProgressPayload` record in
 * `apps/api/src/SharedCookbook.Api/Hubs/LiveSyncPayloads.cs` — keep
 * the two in lockstep. Keys are camelCase on the wire (see
 * `[JsonPropertyName]` decorators on the .NET side).
 */
export interface RecipeImportProgressEventPayload {
  importId: string
  groupId: string
  phase: RecipeImportPhase
  /** 0–100 weighted global progress. */
  progress: number
  /** 0–100 within-phase progress. */
  phaseProgress: number
  /** Server-computed German copy, never null on this event. */
  progressLabel: string
  attemptNumber: number
  bytesDownloaded?: number | null
  bytesTotal?: number | null
  segmentsDone?: number | null
  segmentsTotal?: number | null
}
