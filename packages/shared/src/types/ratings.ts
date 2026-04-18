/**
 * Rating DTOs — mirrors .NET API in `FamilienKochbuch.Api/Endpoints/
 * RatingEndpoints.cs`. Hand-written for now; OpenAPI-generated later.
 */

export interface RatingDto {
  userId: string
  displayName: string
  stars: number
  comment?: string | null
  createdAt: string
  updatedAt: string
}

export interface RatingAggregate {
  /** Server rounds to one decimal; null when nobody has rated yet. */
  avg: number | null
  count: number
  /** Current user's star rating; null when they haven't rated. */
  myStars: number | null
  /** Current user's comment, if present. */
  myComment?: string | null
}

export interface UpsertRatingRequest {
  stars: number
  comment?: string
}

export interface RatingListResponse {
  aggregate: RatingAggregate
  ratings: RatingDto[]
}

export interface UpsertRatingResponse {
  aggregate: RatingAggregate
  rating: RatingDto
}
