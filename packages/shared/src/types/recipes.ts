/**
 * Recipe-related DTOs mirroring the .NET API contract in
 * `FamilienKochbuch.Api/Endpoints/RecipeEndpoints.cs`. Hand-written for now;
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

export interface RecipeSummaryListDto {
  items: RecipeSummaryDto[]
  page: number
  pageSize: number
  total: number
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
  ingredients: IngredientDto[]
  steps: RecipeStepDto[]
  tags: TagDto[]
  /** P2-10: optional per-portion nutrition estimate. `null` = no estimate. */
  nutritionEstimate: NutritionEstimate | null
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

export interface CreateRecipeRequest {
  title: string
  description?: string
  defaultServings: number
  prepTimeMinutes?: number
  difficulty: number
  sourceUrl?: string
  ingredients: IngredientDto[]
  steps: RecipeStepDto[]
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
