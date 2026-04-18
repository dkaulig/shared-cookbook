/**
 * User-facing auth DTOs mirroring the .NET API contract in
 * `FamilienKochbuch.Api/Endpoints/AuthEndpoints.cs`. Hand-written for now;
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

export interface ApiError {
  code: string
  message: string
}
