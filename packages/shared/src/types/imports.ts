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

/**
 * BUG-034 — why the extractor returned an empty recipe.
 *
 * - `no_recipe_detected` — Azure analysed the sources and emitted zero
 *   ingredients AND zero steps. At least one signal source was
 *   present (transcript / caption URL / blog page) but the LLM still
 *   couldn't find a recipe.
 * - `no_usable_source` — signal-aware follow-up (BUG-034). None of the
 *   three source signals lit up (no caption URL, no blog text, no
 *   transcript). The typical FB-Reel-without-captions-or-audio case;
 *   the copy tells the user "we had nothing to chew on", distinct
 *   from "we had something but found no recipe".
 * - `empty_transcript` — reserved pipeline-level gate; today's
 *   `no_usable_source` covers the silent-video case.
 * - `extractor_error` — extractor degraded to empty-result instead of
 *   propagating as a 500. Reserved — today's pipeline raises instead,
 *   but the enum carries this copy-branch for future use.
 *
 * Mirrors :data:`extractor.pipeline.types.EmptyReason` on the Python
 * side. Keep the literal values in sync — the wire format is
 * snake_case identical on both sides.
 */
export type EmptyReason =
  | 'no_recipe_detected'
  | 'no_usable_source'
  | 'empty_transcript'
  | 'extractor_error'

/**
 * BUG-034 — which source signals the URL extractor observed.
 *
 * The Python pipeline flips each flag at the point it collected a
 * usable signal:
 *
 * - `had_caption_url` — True when a URL candidate was extracted from
 *   the video caption and survived the filter chain (same-host,
 *   video-host, shortener resolution).
 * - `had_blog_source` — True when a blog page was fetched AND yielded
 *   non-empty flattened text (JSON-LD, recipe-scrapers, or BS4
 *   fallback).
 * - `had_transcript` — True when Whisper produced at least ~20
 *   characters of non-whitespace transcript. Background babble
 *   ("hi", "uhh") falls below the threshold.
 *
 * The frontend uses these to render signal-aware German copy when the
 * recipe is empty. Always present on the wire (all three default to
 * `false` when the pipeline didn't see any source) so the UI can
 * branch without null checks.
 *
 * Mirrors `ExtractionSignals` on the Python side.
 */
export interface ExtractionSignals {
  had_caption_url: boolean
  had_blog_source: boolean
  had_transcript: boolean
}

export interface ExtractionResult {
  recipe: ExtractedRecipe
  confidence: ExtractionConfidence
  /**
   * BUG-034 — `true` when post-processing found neither ingredients
   * nor steps. Always present on the wire (always `false` on healthy
   * extractions) so the frontend can branch without null-checks.
   */
  recipe_empty: boolean
  /**
   * BUG-034 — machine-readable classifier the frontend uses to pick
   * explainer copy. `null` iff `recipe_empty === false`.
   */
  empty_reason: EmptyReason | null
  /**
   * BUG-034 (signal-aware follow-up) — which source signals the URL
   * pipeline observed. Drives the variant copy in
   * `EmptyExtractionExplainer` when the recipe is empty.
   *
   * The field is always populated on fresh server responses; the
   * prefill mapper falls back to all-false for legacy / chat-import
   * payloads that pre-date the field, so the inner shape on the
   * frontend never deals with `undefined`.
   */
  signals: ExtractionSignals
}

/**
 * Body for `POST /api/recipes/import/url`.
 *
 * `groupId` must belong to a group the caller is a member of; the .NET
 * endpoint rejects mismatches with 403 `not_a_member`.
 *
 * BUG-013 — `force` (default `false`) is the opt-out for the
 * per-user 7-day import-cache on the server. When the user hits the
 * "Neu extrahieren"-button on the cache-hit banner, the web layer
 * re-submits the same body with `force: true` so the pipeline reruns
 * and a fresh import is queued.
 */
export interface ImportUrlRequest {
  url: string
  groupId: string
  force?: boolean
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
 *
 * BUG-013 — `cached` is `true` when the URL-import endpoint
 * short-circuited to an existing successful import for the same caller
 * + same canonical URL within the 7-day TTL. The referenced
 * `importId` is the cached row's id (already `status === 'done'` with
 * populated `result`); no new Hangfire job was enqueued. Absent / false
 * on fresh imports.
 */
export interface ImportEnqueueResponse {
  importId: string
  cached?: boolean
}

/**
 * BUG-010 — wire shape of `GET /api/imports?mine=true&limit=N`.
 *
 * Lighter than {@link RecipeImportDto}: no `result` field (the list
 * view never surfaces the extracted recipe payload) and no bytes /
 * segments transit fields (those live on the per-id detail view).
 *
 * Field naming mirrors the .NET `ImportEndpoints.ImportSummary` record:
 *   - `status` / `source` arrive TitleCase on the wire and get
 *     normalised to the lowercase unions at the API-client edge, same
 *     pattern as {@link RecipeImportDto}.
 *   - `phase` arrives as the snake-case wire string and gets validated
 *     against {@link RecipeImportPhase}.
 *   - `progressLabel` is the server-derived German copy — already
 *     localised, ready to render.
 *
 * The UI consumes this surface directly; we do not fall back to the
 * per-id DTO for list items so the listing stays zero-extra-requests.
 */
export interface ImportSummaryDto {
  id: string
  groupId: string
  source: ImportSourceKind
  status: ImportStatus
  /** Integer 0–100 (weighted across all phases). */
  progress: number
  phase: RecipeImportPhase
  /** Server-computed German copy; null until the first callback lands. */
  progressLabel: string | null
  sourceUrl: string | null
  createdAt: string
  completedAt: string | null
  errorMessage: string | null
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
  /**
   * BUG-018 — id of the {@link StagedPhotoResponse.stagedPhotoId} the
   * URL-import job auto-created from `recipe.thumbnail_url` (typically
   * the yt-dlp video frame). `null` when the source had no thumbnail
   * or the download failed gracefully (timeout, oversize, non-image
   * content-type, host-allowlist reject).
   *
   * The web layer's `extractedRecipeToPrefill` uses this to seed the
   * staged-photo list it forwards to `POST /api/recipes`, so the user
   * gets the video thumbnail attached without the manual upload step.
   * The persisted SeaweedFS copy outlives the FB-CDN URL expiry.
   */
  thumbnailStagedPhotoId?: string | null
  /**
   * REIMPORT-0 — id of the Recipe the URL-extract job should update in
   * place. Non-null exclusively for imports enqueued by
   * `POST /api/recipes/{id}/reimport`; standard URL / Photo / Chat
   * imports leave this field `null`. The frontend's progress page uses
   * it to distinguish "Done → new recipe form" (null) from "Done →
   * back to detail page" (set) on the terminal-state redirect.
   */
  targetRecipeId?: string | null
}
