/**
 * Account-management DTOs mirroring the .NET API contract in
 * `FamilienKochbuch.Api/Endpoints/AccountEndpoints.cs`. These are for
 * self-service (current user) flows only — admin-targets-other-user
 * operations live in the group/admin slice.
 */

export interface ChangePasswordRequest {
  currentPassword: string
  newPassword: string
  newPasswordConfirm: string
}

export interface ChangeDisplayNameRequest {
  displayName: string
}
