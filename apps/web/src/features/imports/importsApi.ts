import type {
  ApiError,
  ExtractionResult,
  ImportCandidate,
  ImportCandidatesResponse,
  ImportEnqueueResponse,
  ImportPhotosRequest,
  ImportSourceKind,
  ImportStatus,
  ImportSummaryDto,
  ImportUrlRequest,
  RecipeImportDto,
  RecipeImportPhase,
} from '@shared-cookbook/shared'
import { RECIPE_IMPORT_PHASES } from '@shared-cookbook/shared'
import { apiClient } from '@/features/auth/apiClient'

/**
 * Thin HTTP layer for the P2-7 URL-import flow.
 *
 * Talks to the P2-6 bridge endpoints:
 *   - POST /api/recipes/import/url  → returns { importId }.
 *   - GET  /api/imports/:importId   → returns the current RecipeImport
 *                                     state (polled every 2 s).
 *
 * The server serialises the `Status` and `Source` enums as TitleCase
 * (`"Queued"` / `"Url"`); we normalise them to lowercase at the edge
 * so the UI switches stay readable. The `result` field is a JSON
 * string on the wire and only set when `Status === "Done"`; we parse
 * it here so the React layer never has to touch the raw JSON.
 */

async function request<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await apiClient(input, init)
  if (!response.ok) {
    await throwApiError(response)
  }
  if (response.status === 204 || response.headers.get('Content-Length') === '0') {
    return undefined as unknown as T
  }
  return (await response.json()) as T
}

async function throwApiError(response: Response): Promise<never> {
  let payload: ApiError | null = null
  try {
    payload = (await response.json()) as ApiError
  } catch {
    /* non-JSON body — fall through. */
  }
  const code = payload?.code ?? `http_${response.status}`
  const message = payload?.message ?? response.statusText
  const err = new Error(`${code}: ${message}`) as Error & ApiError
  err.code = code
  err.message = message
  // REL-4: pin status + fieldName from the body so downstream
  // classifiers route by authoritative number.
  err.status = payload?.status ?? response.status
  if (payload?.fieldName) err.fieldName = payload.fieldName
  throw err
}

/**
 * Wire shape of `GET /api/imports/:id` — matches the .NET record
 * `ImportEndpoints.ImportStatusResponse`. Enum fields arrive as the
 * TitleCase enum name (`"Queued"`, `"Url"`) and `result` is either
 * `null` or a serialised JSON string. `mapStatusResponse` normalises
 * both.
 *
 * PV4 additions: `groupId` (fixes BUG-012's auto-redirect fragility)
 * plus the full phase-tracking snapshot (`phase`, `phaseProgress`,
 * `progressLabel`, `attemptNumber`, bytes/segments counts,
 * `lastProgressAt`). `phase` travels in the same snake-case wire form
 * the SignalR event and Python callback use.
 */
export interface ImportStatusResponseWire {
  id: string
  groupId: string
  source: string
  status: string
  progress: number
  sourceUrl: string | null
  result: string | null
  error: string | null
  createdAt: string
  completedAt: string | null
  phase: string
  phaseProgress: number
  progressLabel: string | null
  attemptNumber: number
  bytesDownloaded: number | null
  bytesTotal: number | null
  segmentsDone: number | null
  segmentsTotal: number | null
  lastProgressAt: string
  /**
   * COVER-0 — up to 6 staged-photo ids the extract job captured as
   * import-cover candidates (yt-dlp thumbnails + ffmpeg frames +
   * JSON-LD `image[]`). Ordered; `[0]` is the default cover. Absent
   * on legacy server builds — treat missing as `[]`.
   */
  candidateStagedPhotoIds?: string[]
  /**
   * REIMPORT-0 — id of the target recipe this import updates in place
   * on Done. Non-null exclusively for imports enqueued by
   * `POST /api/recipes/{id}/reimport`; the frontend's progress page
   * uses the value to dispatch the terminal-state redirect (null → new
   * recipe form, set → back to detail page). May be absent on older
   * server builds — treat absent as null.
   */
  targetRecipeId?: string | null
  /**
   * AI-Normalize toggle (2026-04-27 design, slice 3) — captured user
   * intent for LLM-based JSON-LD normalisation. Mirrors the persisted
   * `RecipeImport.AiNormalizeActive` server-side field. Absent on
   * legacy server builds — treat absent as `false`.
   */
  aiNormalizeActive?: boolean
}

function normaliseStatus(raw: string): ImportStatus {
  const lower = raw.toLowerCase()
  if (lower === 'queued' || lower === 'running' || lower === 'done' || lower === 'error') {
    return lower
  }
  // Unknown enum name — surface as "error" so the UI shows the error
  // branch rather than polling forever.
  return 'error'
}

function normaliseSource(raw: string): ImportSourceKind {
  const lower = raw.toLowerCase()
  if (lower === 'url' || lower === 'photos' || lower === 'chat') {
    return lower
  }
  return 'url'
}

/**
 * Guards the wire `phase` string against the known snake-case union
 * exported as {@link RECIPE_IMPORT_PHASES}. An unknown wire value
 * (future-server-before-deploy-propagates, or a bad proxy) collapses
 * to `'error'` so the UI shows the terminal branch instead of silently
 * drifting into an "undefined phase" visual. A missing/blank wire value
 * collapses to `'queued'` — the sensible pre-first-callback default and
 * what the backend ships on a freshly-created import before any phase
 * update lands.
 */
function normalisePhase(raw: string | null | undefined): RecipeImportPhase {
  if (raw == null || raw === '') return 'queued'
  const lower = raw.toLowerCase()
  const match = (RECIPE_IMPORT_PHASES as readonly string[]).includes(lower)
  return match ? (lower as RecipeImportPhase) : 'error'
}

export function mapStatusResponse(wire: ImportStatusResponseWire): RecipeImportDto {
  let result: ExtractionResult | null = null
  if (wire.result != null) {
    try {
      result = JSON.parse(wire.result) as ExtractionResult
    } catch {
      // Bad JSON on the wire is a server bug — don't wedge the UI.
      // Leaving `result` null means the progress page falls through to
      // the error branch once status flips to "done" with no payload.
      result = null
    }
  }
  return {
    id: wire.id,
    groupId: wire.groupId,
    source: normaliseSource(wire.source),
    status: normaliseStatus(wire.status),
    progress: wire.progress,
    sourceUrl: wire.sourceUrl,
    result,
    errorMessage: wire.error,
    createdAt: wire.createdAt,
    completedAt: wire.completedAt,
    // PV4 — phase-tracking snapshot. The endpoint always populates
    // these now; the TS type keeps them optional for SignalR-first
    // race where the live cache seed has not yet happened.
    phase: normalisePhase(wire.phase),
    phaseProgress: wire.phaseProgress,
    progressLabel: wire.progressLabel,
    attemptNumber: wire.attemptNumber,
    bytesDownloaded: wire.bytesDownloaded,
    bytesTotal: wire.bytesTotal,
    segmentsDone: wire.segmentsDone,
    segmentsTotal: wire.segmentsTotal,
    lastProgressAt: wire.lastProgressAt,
    // COVER-0 — pass through verbatim. `[]` (or absent on legacy
    // builds) means the import yielded no cover candidates and the
    // picker UI should render its zero-state.
    candidateStagedPhotoIds: wire.candidateStagedPhotoIds ?? [],
    // REIMPORT-0 — pass through verbatim. `null` (or absent on old
    // builds) means this is a standard import; the progress page
    // falls through to the new-recipe-form branch on Done.
    targetRecipeId: wire.targetRecipeId ?? null,
    // AI-Normalize toggle (slice 3) — pass through verbatim. Absent on
    // legacy server builds normalises to `false` so the reimport-
    // dialog's pre-fill is always a defined boolean.
    aiNormalizeActive: wire.aiNormalizeActive ?? false,
  }
}

/** Enqueue a URL-based import. Returns the new import id. */
export async function enqueueUrlImport(
  body: ImportUrlRequest,
): Promise<ImportEnqueueResponse> {
  return request<ImportEnqueueResponse>('/api/recipes/import/url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/**
 * Enqueue a photo-based import (P2-8). Body carries the ordered array of
 * signed photo URLs (each produced by `uploadStagedPhoto`) + the target
 * group. Server responds 202 with the new `{ importId }`.
 */
export async function enqueuePhotoImport(
  body: ImportPhotosRequest,
): Promise<ImportEnqueueResponse> {
  return request<ImportEnqueueResponse>('/api/recipes/import/photos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Fetch the current state of an import. Used by the polling query. */
export async function fetchImport(importId: string): Promise<RecipeImportDto> {
  const wire = await request<ImportStatusResponseWire>(
    `/api/imports/${encodeURIComponent(importId)}`,
  )
  return mapStatusResponse(wire)
}

/**
 * COVER-0 — fetch the freshly-signed URLs for an import's still-
 * unpromoted cover candidates. Used by the RecipeFormPage's picker
 * grid (pre-save) and — in a later slice — by the RecipeDetailPage
 * "Cover ändern" modal (post-save, within the 7-day TTL window).
 *
 * Server returns 410 Gone when the sweep has reaped all candidates;
 * callers surface that as a "no picker UI" zero-state rather than
 * an error banner. 403 when the caller doesn't own the import.
 */
export async function fetchImportCandidates(
  importId: string,
): Promise<ImportCandidate[]> {
  const res = await request<ImportCandidatesResponse>(
    `/api/imports/${encodeURIComponent(importId)}/candidates`,
  )
  return res.candidates
}

/**
 * BUG-010 — wire shape of `GET /api/imports?mine=true&limit=N`.
 * Matches the .NET `ImportSummary` record field-for-field. Enum fields
 * arrive TitleCase and get lowered at the mapper edge, consistent with
 * {@link ImportStatusResponseWire}.
 */
export interface ImportSummaryWire {
  id: string
  groupId: string
  source: string
  status: string
  progress: number
  phase: string
  progressLabel: string | null
  sourceUrl: string | null
  createdAt: string
  completedAt: string | null
  error: string | null
}

/**
 * Normalises one wire row into the {@link ImportSummaryDto} surface the
 * list UI consumes. The wire→DTO mapping is identical in spirit to
 * {@link mapStatusResponse}: TitleCase → lowercase for status / source,
 * snake-case → union for phase, and the shorter `error` wire key is
 * renamed to `errorMessage` so it aligns with the rest of the imports
 * DTO surface.
 */
export function mapImportSummary(wire: ImportSummaryWire): ImportSummaryDto {
  return {
    id: wire.id,
    groupId: wire.groupId,
    source: normaliseSource(wire.source),
    status: normaliseStatus(wire.status),
    progress: wire.progress,
    phase: normalisePhase(wire.phase),
    progressLabel: wire.progressLabel,
    sourceUrl: wire.sourceUrl,
    createdAt: wire.createdAt,
    completedAt: wire.completedAt,
    errorMessage: wire.error,
  }
}

/**
 * BUG-010 — fetch the caller's most-recent imports (newest first).
 *
 * The endpoint serialises `Status` / `Source` as TitleCase enum names
 * and `Phase` as the snake-case wire form; this wrapper normalises both
 * at the edge so the consuming React layer stays on the lowercase /
 * union surface the rest of the app uses.
 */
export async function fetchMyImports(
  limit = 20,
): Promise<ImportSummaryDto[]> {
  const wire = await request<ImportSummaryWire[]>(
    `/api/imports?mine=true&limit=${encodeURIComponent(String(limit))}`,
  )
  return wire.map(mapImportSummary)
}

/**
 * Slice 3 — POST /api/imports/{importId}/retry. Resets a Failed import
 * back to Queued (AttemptNumber 1, error message cleared) and re-enqueues
 * the matching Hangfire job. The endpoint returns the standard
 * `ImportStatusResponse` shape with the post-reset row so the FE can
 * drop the payload straight into its TanStack-Query cache and flip the
 * UI without a second GET. 409 / `import_not_failed` if the row isn't
 * Failed; 403 if the caller isn't the owner or no longer a member of
 * the group; 404 if the import doesn't exist.
 */
export async function retryImport(importId: string): Promise<RecipeImportDto> {
  const wire = await request<ImportStatusResponseWire>(
    `/api/imports/${encodeURIComponent(importId)}/retry`,
    { method: 'POST' },
  )
  return mapStatusResponse(wire)
}
