/**
 * Recipe-import DTOs — mirror the .NET `ImportStatusResponse` (see
 * `apps/api/src/FamilienKochbuch.Api/Endpoints/ImportEndpoints.cs`)
 * + the Python extractor `ExtractionResult` shape (see
 * `apps/python-extractor/src/extractor/pipeline/types.py`).
 *
 * The bridge works like this:
 *   1. The frontend POSTs `/api/recipes/import/url` → the .NET endpoint
 *      enqueues a Hangfire job and returns `{ importId }`.
 *   2. The frontend polls `/api/imports/{importId}` every 2 s until the
 *      job reports `status === 'done' || 'error'`.
 *   3. On done, `result` carries the structured `ExtractionResult`
 *      (the Python pipeline's output); the frontend prefills
 *      `RecipeFormPage` from the nested `recipe` field.
 *
 * The .NET endpoint serialises `Status`/`Source` as TitleCase enum names
 * (`"Queued"`, `"Running"`, `"Done"`, `"Error"`, `"Url"`, `"Photos"`,
 * `"Chat"`); this frontend normalises them to lowercase strings so the
 * UI switches stay readable. Normalisation happens in the API client —
 * the DTO surface facing React components is always lowercase.
 */

import type { RecipeImportPhase } from './recipeImport.ts'

export type ImportStatus = 'queued' | 'running' | 'done' | 'error'

export type ImportSourceKind = 'url' | 'photos' | 'chat'

/**
 * Per-ingredient confidence.
 *
 * - ``high`` / ``medium`` / ``low`` — standard LLM confidence buckets.
 * - ``missing`` — post-processing flagged a row without a quantity
 *   (review badge reads "Menge fehlt").
 * - ``handwritten_uncertain`` — emitted only by the Photo path (P2-3);
 *   review badge reads "Handschrift prüfen".
 */
export type IngredientConfidenceLevel =
  | 'high'
  | 'medium'
  | 'low'
  | 'missing'
  | 'handwritten_uncertain'

export type StepConfidenceLevel =
  | 'high'
  | 'medium'
  | 'low'
  | 'handwritten_uncertain'

export type ConfidenceLevel = 'high' | 'medium' | 'low'

export interface ExtractedIngredient {
  name: string
  quantity: string | null
  unit: string | null
  note: string | null
  confidence: IngredientConfidenceLevel
}

export interface ExtractedStep {
  /** 1-indexed position, mirroring the Python pipeline. */
  position: number
  content: string
  confidence: StepConfidenceLevel
}

/**
 * LLM-estimated per-portion nutrition in the Python extractor's
 * snake_case shape. `ExtractedRecipe` uses this form; the web layer
 * translates to `NutritionEstimate` (camelCase) before persistence.
 */
export interface ExtractedNutritionEstimate {
  kcal: number
  protein_g: number
  carbs_g: number
  fat_g: number
}

export interface ExtractedRecipe {
  title: string
  description: string | null
  servings: number | null
  difficulty: number | null
  prep_minutes: number | null
  cook_minutes: number | null
  ingredients: ExtractedIngredient[]
  steps: ExtractedStep[]
  tags: string[]
  source_url: string
  thumbnail_url: string | null
  /**
   * P2-10: optional per-portion nutrition estimate. Omitted or `null`
   * when the LLM couldn't infer quantities; mirrors the Python
   * `ExtractedRecipe` TypedDict key.
   */
  nutrition_estimate?: ExtractedNutritionEstimate | null
}

export interface ExtractionConfidence {
  overall: ConfidenceLevel
  notes: string[]
}

export interface ExtractionResult {
  recipe: ExtractedRecipe
  confidence: ExtractionConfidence
}

/**
 * Body for `POST /api/recipes/import/url`.
 *
 * `groupId` must belong to a group the caller is a member of; the .NET
 * endpoint rejects mismatches with 403 `not_a_member`.
 */
export interface ImportUrlRequest {
  url: string
  groupId: string
}

/**
 * Body for `POST /api/recipes/import/photos`. Same shape as the .NET
 * `PhotoImportRequest` record — an ordered array of signed photo URLs
 * (each produced by the staged-upload endpoint) plus a target groupId.
 */
export interface ImportPhotosRequest {
  photoUrls: string[]
  groupId: string
}

/**
 * Response for `POST /api/recipes/photos/staged`.
 *
 * Original P2-8 contract returned `{ photoId, signedUrl }`: the bare
 * SeaweedFS storage path + the freshly-signed proxy URL handed off to
 * `POST /api/recipes/import/photos`. PF1 adds `stagedPhotoId` — the
 * `StagedPhoto` row's domain key, consumed by the create-recipe
 * endpoint when promoting the staged blob onto a saved recipe.
 *
 * Both ids coexist deliberately: `photoId` stays for backward
 * compatibility (the import-photos flow still serializes the signed
 * URL), and `stagedPhotoId` is the new currency for the promote
 * handshake.
 */
export interface StagedPhotoResponse {
  photoId: string
  signedUrl: string
  stagedPhotoId: string
}

/**
 * Response for the enqueue endpoints — matches
 * `ImportEndpoints.ImportEnqueueResponse` on the .NET side.
 */
export interface ImportEnqueueResponse {
  importId: string
}

/**
 * Client-facing shape for `GET /api/imports/{importId}`.
 *
 * Corresponds to `ImportEndpoints.ImportStatusResponse` on the server
 * with two normalisations applied by the API client:
 *   - `status` / `source` lowercased.
 *   - `result` parsed from JSON string → `ExtractionResult` when done.
 *     While still queued/running/errored it stays `null`.
 *
 * PV4 — the server now includes the full phase-tracking snapshot AND
 * `groupId` directly on the wire. The previous "groupId is route-state
 * only" comment (and the BUG-012 redirect fragility that entailed) is
 * gone; the auto-redirect on Done now works reliably even after reload
 * or a new-tab deep-link.
 *
 * Phase-related fields stay optional on the TS type to keep the union
 * compatible with the historic SignalR-only-populates-these path in
 * `useLiveSync` (which seeds the cache before the first poll completes).
 * The REST endpoint always populates them now, so the "?" is purely
 * defensive against the SignalR-first race.
 */
export interface RecipeImportDto {
  id: string
  /**
   * PV4 — target group for the import. Present on every wire response
   * (the .NET endpoint owner-check already loaded the row). Used by the
   * progress page to redirect to `/groups/{groupId}/recipes/new` on Done
   * without depending on fragile navigation-state / sessionStorage.
   */
  groupId: string
  source: ImportSourceKind
  status: ImportStatus
  /** Integer 0–100 (weighted across all phases). */
  progress: number
  sourceUrl: string | null
  /** Populated only when `status === 'done'`. */
  result: ExtractionResult | null
  errorMessage: string | null
  createdAt: string
  completedAt: string | null
  /**
   * PV3 — phase-aware progress fields. Populated from the SignalR
   * `RecipeImportProgressChanged` event (see {@link ./recipeImport.ts})
   * AND (PV4) from `GET /api/imports/:id` directly.
   */
  phase?: RecipeImportPhase
  /** 0–100 progress within the current phase. */
  phaseProgress?: number
  /** Server-computed German copy; null when backend hasn't provided one yet. */
  progressLabel?: string | null
  attemptNumber?: number
  /** ISO-8601 timestamp of the most recent progress update. */
  lastProgressAt?: string
  bytesDownloaded?: number | null
  bytesTotal?: number | null
  segmentsDone?: number | null
  segmentsTotal?: number | null
}
