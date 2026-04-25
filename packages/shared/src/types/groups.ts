/**
 * Group-related DTOs mirroring the .NET API contract in
 * `SharedCookbook.Api/Endpoints/GroupEndpoints.cs`. Hand-written for now;
 * will be generated from the OpenAPI spec in a later slice.
 */

export type GroupRole = 'Admin' | 'Member'
export type InviteStatus = 'Pending' | 'Accepted' | 'Declined'

export interface GroupSummary {
  id: string
  name: string
  description?: string | null
  coverImageUrl?: string | null
  defaultServings: number
  isPrivateCollection: boolean
  memberCount: number
  myRole: GroupRole
  /**
   * OFF3 optimistic-concurrency counter — mirrors `Group.Version`.
   * Starts at 0 on a freshly-created group; bumps by one on every
   * metadata edit / soft-delete. Client echoes as
   * `If-Match: W/"<id>-<version>"` on subsequent PUT/DELETE.
   */
  version: number
}

export interface GroupMember {
  userId: string
  displayName: string
  role: GroupRole
  joinedAt: string
}

export interface GroupDetail extends GroupSummary {
  members: GroupMember[]
}

export interface GroupInviteReceived {
  id: string
  groupId: string
  groupName: string
  inviterDisplayName: string
  createdAt: string
}

export interface GroupInviteCreated {
  id: string
  groupId: string
  invitedUserId: string
  status: InviteStatus
  createdAt: string
}

/**
 * Row shape for `GET /api/groups/{id}/invites` (admin-only listing of
 * outstanding invites for a group). Unlike `GroupInviteCreated`, this
 * carries the invited user's display name so the admin UI can render
 * the list without a second lookup.
 */
export interface GroupInviteListItem {
  id: string
  groupId: string
  invitedUserId: string
  invitedUserDisplayName: string
  status: InviteStatus
  createdAt: string
}

export interface CreateGroupRequest {
  name: string
  description?: string
  defaultServings?: number
}

export interface UpdateGroupRequest {
  name?: string
  description?: string
  defaultServings?: number
  coverImageUrl?: string
}

export interface InviteToGroupRequest {
  invitedUserId: string
}

export interface ChangeMemberRoleRequest {
  role: GroupRole
}

export interface UserSearchResult {
  id: string
  displayName: string
  avatarUrl?: string | null
}
