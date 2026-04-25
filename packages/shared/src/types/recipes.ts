/**
 * Recipe-related DTOs mirroring the .NET API contract in
 * `SharedCookbook.Api/Endpoints/RecipeEndpoints.cs`. Hand-written for now;
 * will be generated from the OpenAPI spec in a later slice.
 */

export type RecipeSourceType = 'Manual' | 'Video' | 'Chat' | 'Photo'

export type TagCategory =
  | 'Mahlzeit'
  | 'Saison'
  | 'Typ'
  | 'Aufwand'
  | 'Diaet'
  | 'Kueche'
  | 'Komponente'
  | 'Custom'

export interface IngredientDto {
  /** Present on DTOs coming back from the API; omitted on creates. */
  id?: string
  position: number
  quantity?: number | null
  unit: string
  name: string
  note?: string | null
  scalable: boolean
}

export interface RecipeStepDto {
  id?: string
  position: number
  content: string
}

/**
 * COMP-0/2 — one sub-recipe group inside a recipe. Simple recipes carry
 * exactly one component with `label === null` and `position === 0`; the
 * frontend renders that case identically to the pre-COMP-0 flat
 * ingredient/step layout. Multi-part recipes (e.g. "Chipotle Sauce" +
 * "Main") surface multiple components in emit-order with user- or
 * LLM-supplied labels.
 *
 * Per-component `ingredients` and `steps` are already scoped and
 * ordered by their own `position` fields — callers don't need to
 * re-filter on `ComponentId`.
 */
export interface RecipeComponentDto {
  /** Present on DTOs coming back from the API; omitted on creates. */
  id?: string
  /** 0-based, unique within the recipe. */
  position: number
  /**
   * User- or LLM-supplied label (e.g. "Chipotle Sauce"). `null` marks
   * the single-default component the backend seeds on simple recipes —
   * the detail page suppresses header chrome in that case.
   */
  label: string | null
  ingredients: IngredientDto[]
  steps: RecipeStepDto[]
}

export interface TagDto {
  id: string
  name: string
  category: TagCategory
  isGlobal: boolean
  groupId?: string | null
  createdByUserId?: string | null
}

/**
 * LLM-estimated per-portion nutrition values (P2-10). All four fields
 * are integers (kcal whole; macros in grams). The Python post-processor
 * clamps to sane ranges (kcal 0..5000, macros 0..500) before the value
 * reaches this DTO.
 *
 * `null` on the DTOs means "no estimate available" — either the LLM
 * couldn't infer quantities from the source or the user cleared the
 * estimate manually via the PATCH endpoint. The detail page hides the
 * Nährwerte section entirely in that case.
 */
export interface NutritionEstimate {
  kcal: number
  proteinG: number
  carbsG: number
  fatG: number
}

export interface RecipeSummaryDto {
  id: string
  groupId: string
  title: string
  description?: string | null
  photo?: string | null
  tagIds: string[]
  createdByDisplayName: string
  updatedAt: string
  /** Rounded to one decimal; null when nobody has rated yet. */
  avgRating: number | null
  ratingCount: number
  /** Current user's rating, or null when they haven't rated. */
  myStars: number | null
}

/**
 * PAGE-1 — sort enum accepted by the paginated recipe-list endpoint
 * (`GET /api/groups/:groupId/recipes`). Mirrors backend PAGE-0's
 * `RecipeListSort`. One of `cook_count_desc` / `rating_desc` may be cut
 * server-side if the underlying column isn't available — the frontend
 * offers all five optimistically; an unsupported choice surfaces as a
 * 400 `invalid_sort` which the standard list-load-error toast picks up.
 */
export type RecipeListSort =
  | 'updated_desc'
  | 'cooked_desc'
  | 'title_asc'
  | 'cook_count_desc'
  | 'rating_desc'

export const DEFAULT_RECIPE_LIST_SORT: RecipeListSort = 'updated_desc'
export const DEFAULT_RECIPE_LIST_PAGE_SIZE = 24

export interface RecipeSummaryListDto {
  items: RecipeSummaryDto[]
  page: number
  pageSize: number
  total: number
  /** PAGE-1 — cheap derived flags so pagination UI doesn't reimplement
   *  `page > 1` / `page * pageSize < total`. */
  hasNextPage: boolean
  hasPrevPage: boolean
}

export interface RecipeDetailDto {
  id: string
  groupId: string
  createdByUserId: string
  createdByDisplayName: string
  title: string
  description?: string | null
  defaultServings: number
  prepTimeMinutes?: number | null
  difficulty: number
  sourceUrl?: string | null
  sourceType: RecipeSourceType
  forkOfRecipeId?: string | null
  photos: string[]
  lastCookedAt?: string | null
  createdAt: string
  updatedAt: string
  /**
   * OFF3 optimistic-concurrency counter — mirrors `Recipe.Version`.
   * Starts at 0 on a freshly-created recipe; bumps by one on every
   * mutation. Client echoes as `If-Match: W/"<id>-<version>"` on
   * subsequent PUT/POST/DELETE/PATCH to detect conflicts.
   */
  version: number
  /**
   * COMP-0/2 — nested sub-recipe groups. Every recipe has ≥1 component.
   * Single-default recipes surface as
   * `[{ label: null, position: 0, ingredients: [...], steps: [...] }]`;
   * the detail page renders that case identically to the pre-COMP-0
   * flat layout. Multi-component recipes render one `<h2>` section
   * per component (label OR the German fallback "Hauptgericht" when
   * a multi-component recipe still has a null-labelled entry).
   */
  components: RecipeComponentDto[]
  tags: TagDto[]
  /** P2-10: optional per-portion nutrition estimate. `null` = no estimate. */
  nutritionEstimate: NutritionEstimate | null
  /**
   * LANG-2: two-letter ISO code (`'de'` | `'en'`) of the recipe's
   * authored content. The detail page renders the Translate button only
   * when this differs from the active UI language. Pre-LANG-2 rows
   * backfill to `'de'` via the migration default.
   */
  sourceLanguage: string
  /**
   * PF1: per-photo failures from the create-recipe promote flow.
   * Always omitted/`null` for read paths (Get/Update/Fork/...) — the
   * field is only populated on the response of the create endpoint
   * when one or more `stagedPhotoIds` failed to attach.
   */
  partialPhotoFailures?: PartialPhotoFailureDto[] | null
}

/**
 * PF1 — per-photo failure surfaced by the create-recipe response when
 * `stagedPhotoIds` were supplied and at least one couldn't be attached
 * (unknown id, ownership mismatch, already promoted, copy failure).
 * The frontend renders a banner naming N of M failures so the user
 * can re-upload them manually from the detail page.
 */
export interface PartialPhotoFailureDto {
  stagedPhotoId: string
  reason: string
}

/**
 * LANG-2 — server response of `POST /api/recipes/:id/translate`. The
 * `translatedPayload` carries the JSON document the LLM returned;
 * the frontend merges it onto the source `RecipeDetailDto` to render
 * (numbers + photo URLs stay byte-identical because the payload only
 * contains translatable text). `isStale` flips when a recipe edit
 * happens between cache and re-fetch; `cacheHit` is informational.
 */
export interface RecipeTranslationResponse {
  recipeId: string
  language: string
  translatedPayload: string
  isStale: boolean
  cacheHit: boolean
  updatedAt: string
}

/**
 * LANG-2 — shape of the JSON document inside
 * `RecipeTranslationResponse.translatedPayload`. Mirrors the
 * server-side `RecipeTranslationPrompt.SerializeSource` contract:
 * translatable subset of the recipe shape, anchored by stable IDs and
 * positions so the merge with the source recipe stays unambiguous.
 */
export interface RecipeTranslationPayload {
  title: string
  description?: string | null
  components: TranslatedComponentDto[]
  tags: TranslatedTagDto[]
}

export interface TranslatedComponentDto {
  id: string
  position: number
  label?: string | null
  ingredients: TranslatedIngredientDto[]
  steps: TranslatedStepDto[]
}

export interface TranslatedIngredientDto {
  position: number
  name: string
  unit?: string | null
  note?: string | null
}

export interface TranslatedStepDto {
  position: number
  content: string
}

export interface TranslatedTagDto {
  id: string
  name: string
}

export interface CreateRecipeRequest {
  title: string
  description?: string
  defaultServings: number
  prepTimeMinutes?: number
  difficulty: number
  sourceUrl?: string
  /**
   * COMP-0/2 — nested component payload. At least one entry required.
   * Single-default form state maps to
   * `[{ position: 0, label: null, ingredients: [...], steps: [...] }]`.
   */
  components: RecipeComponentDto[]
  tagIds: string[]
  /**
   * P2-10: optional per-portion nutrition estimate flowed through from
   * the AI import pipeline (URL / photo / chat). Omit or pass `null`
   * when the LLM couldn't estimate — the server stores `null`.
   */
  nutritionEstimate?: NutritionEstimate | null
  /**
   * PF1: optional list of `StagedPhoto.Id` values to promote onto the
   * new recipe. The server verifies ownership + adoption status; per-id
   * failures land in `RecipeDetailDto.partialPhotoFailures` rather
   * than blocking the recipe creation itself.
   */
  stagedPhotoIds?: string[]
  /**
   * COVER-0 — which of the `stagedPhotoIds` should become the recipe's
   * cover. Must be a member of `stagedPhotoIds` when set (400 otherwise);
   * omit to fall back to the `stagedPhotoIds[0]`-default behaviour that
   * predated the import-cover picker. Single-photo create paths that
   * don't surface the picker can leave this unset.
   */
  coverStagedPhotoId?: string
}

export interface UpdateRecipeRequest extends CreateRecipeRequest {}

export interface UploadPhotoResponse {
  url: string
}

export interface RemovePhotoRequest {
  url: string
}

export interface ForkRecipeRequest {
  targetGroupId: string
}

// ── S6: Version history ────────────────────────────────────────────────

export type RecipeChangeType = 'Created' | 'Edited' | 'Forked'

export interface RecipeRevisionChangedBy {
  userId: string
  displayName: string
}

export interface RecipeRevisionSummary {
  id: string
  changeType: RecipeChangeType
  changedBy: RecipeRevisionChangedBy
  /** Optional German one-liner — null on the first Created revision when
   *  the service hasn't decorated it. */
  diffSummary?: string | null
  createdAt: string
}

export interface RecipeSnapshotIngredient {
  position: number
  quantity: number | null
  unit: string
  name: string
  note?: string | null
  scalable: boolean
}

export interface RecipeSnapshotStep {
  position: number
  content: string
}

export interface RecipeSnapshot {
  title: string
  description?: string | null
  defaultServings: number
  prepTimeMinutes?: number | null
  difficulty: 1 | 2 | 3
  sourceUrl?: string | null
  ingredients: RecipeSnapshotIngredient[]
  steps: RecipeSnapshotStep[]
  tagIds: string[]
}

export interface RecipeRevisionDetail extends RecipeRevisionSummary {
  snapshot: RecipeSnapshot
}

// ── COVER-0 Slice E — origin-import lookup ────────────────────────

/**
 * COVER-0 Slice E — wire shape of `GET /api/recipes/:id/origin-import`.
 *
 * Lets the RecipeDetailPage discover the `RecipeImport.id` that
 * produced this recipe without threading the id through client-side
 * state that was already torn down after save. The response is 200
 * with `{ importId }` when a linkage exists, 404 otherwise. Only the
 * recipe owner can call the endpoint (no admin bypass).
 *
 * The detail page uses the returned id to fire
 * {@link ImportCandidatesResponse | `/api/imports/:id/candidates`}
 * lazily — only when the "Cover ändern" button would render.
 */
export interface RecipeOriginImportResponse {
  importId: string
}
