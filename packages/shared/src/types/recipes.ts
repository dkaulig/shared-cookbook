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
  ingredients: IngredientDto[]
  steps: RecipeStepDto[]
  tags: TagDto[]
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
