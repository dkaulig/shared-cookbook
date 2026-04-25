/**
 * User-facing auth DTOs mirroring the .NET API contract in
 * `SharedCookbook.Api/Endpoints/AuthEndpoints.cs`. Hand-written for now;
 * will be generated from the OpenAPI spec in a later slice.
 */
export type UserRole = 'User' | 'Admin'

export interface AuthUser {
  id: string
  email: string
  displayName: string
  role: UserRole
}

export interface AuthResponse {
  accessToken: string
  user: AuthUser
}

export interface SignupRequest {
  email: string
  password: string
  displayName: string
}

export interface LoginRequest {
  email: string
  password: string
}

export interface PasswordResetRequestBody {
  email: string
}

export interface PasswordResetBody {
  token: string
  newPassword: string
}

export interface InvitePreview {
  valid: boolean
  expiresAt: string
  inviterDisplayName?: string | null
}

export interface CreateInviteRequest {
  email?: string
}

export interface CreateInviteResponse {
  id: string
  token: string
  inviteUrl: string
  expiresAt: string
}

/**
 * Wire shape of every non-2xx response body from the .NET API. REL-4
 * (commit 948e2c2) made `status` mandatory — it mirrors the HTTP status
 * code so clients don't have to track it separately alongside the JSON
 * body. `fieldName` is optional and only set on 400 validation failures
 * that can be attributed to a specific request field (e.g. `servings`,
 * `displayName`).
 */
export interface ApiError {
  code: string
  message: string
  status: number
  fieldName?: string
}
