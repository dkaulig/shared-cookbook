import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  CreateGroupRequest,
  GroupDetail,
  GroupInviteCreated,
  GroupInviteListItem,
  GroupInviteReceived,
  GroupMember,
  GroupRole,
  GroupSummary,
  InviteToGroupRequest,
  UpdateGroupRequest,
  UserSearchResult,
} from '@shared-cookbook/shared'
import {
  acceptGroupInvite,
  createGroup,
  createGroupInvite,
  declineGroupInvite,
  deleteGroup,
  fetchGroupDetail,
  fetchGroupInvites,
  fetchGroupMembers,
  fetchReceivedInvites,
  removeGroupMember,
  revokeGroupInvite,
  searchUsers,
  updateGroup,
  updateGroupMemberRole,
} from './groupsApi'
import { groupQueryKeys } from './queryKeys'

/** Read the details (incl. members) of a specific group. */
export function useGroup(groupId: string | undefined) {
  return useQuery<GroupDetail>({
    queryKey: groupId ? groupQueryKeys.detail(groupId) : ['groups', 'detail', 'disabled'],
    queryFn: () => fetchGroupDetail(groupId!),
    enabled: !!groupId,
  })
}

/** Read the full member list of a specific group. */
export function useGroupMembers(groupId: string | undefined) {
  return useQuery<GroupMember[]>({
    queryKey: groupId ? groupQueryKeys.members(groupId) : ['groups', 'members', 'disabled'],
    queryFn: () => fetchGroupMembers(groupId!),
    enabled: !!groupId,
  })
}

/**
 * Admin-only list of outstanding (Pending) invites for a specific
 * group. Feeds the invites section of `GroupMembersAndInvitesPanel`.
 * Returns a disabled query when `groupId` is undefined so the same
 * hook can sit next to `useGroup(id)` without a guard at the call
 * site.
 */
export function useGroupInvites(groupId: string | undefined) {
  return useQuery<GroupInviteListItem[]>({
    queryKey: groupId
      ? groupQueryKeys.groupInvites(groupId)
      : ['groups', 'groupInvites', 'disabled'],
    queryFn: () => fetchGroupInvites(groupId!),
    enabled: !!groupId,
  })
}

/** Pending received invites for the current user. */
export function useMyReceivedInvites() {
  return useQuery<GroupInviteReceived[]>({
    queryKey: groupQueryKeys.invitesReceived(),
    queryFn: fetchReceivedInvites,
  })
}

/** Debounced user search. Pass an empty query to disable the request. */
export function useUserSearch(q: string, excludeGroupId?: string) {
  return useQuery<UserSearchResult[]>({
    queryKey: groupQueryKeys.userSearch(q, excludeGroupId),
    queryFn: () => searchUsers(q, excludeGroupId),
    enabled: q.trim().length > 0,
  })
}

// ── Mutations ───────────────────────────────────────────────────────

export function useCreateGroup() {
  const client = useQueryClient()
  return useMutation<GroupSummary, Error, CreateGroupRequest>({
    mutationFn: createGroup,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: groupQueryKeys.mine() })
    },
  })
}

export function useUpdateGroup(groupId: string) {
  const client = useQueryClient()
  return useMutation<GroupSummary, Error, UpdateGroupRequest>({
    mutationFn: (body) => updateGroup(groupId, body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: groupQueryKeys.mine() })
      void client.invalidateQueries({ queryKey: groupQueryKeys.detail(groupId) })
    },
  })
}

export function useDeleteGroup() {
  const client = useQueryClient()
  return useMutation<void, Error, string>({
    mutationFn: deleteGroup,
    onSuccess: (_data, groupId) => {
      void client.invalidateQueries({ queryKey: groupQueryKeys.mine() })
      void client.removeQueries({ queryKey: groupQueryKeys.detail(groupId) })
    },
  })
}

export function useInviteToGroup(groupId: string) {
  const client = useQueryClient()
  return useMutation<GroupInviteCreated, Error, InviteToGroupRequest>({
    mutationFn: (body) => createGroupInvite(groupId, body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: groupQueryKeys.detail(groupId) })
      void client.invalidateQueries({ queryKey: groupQueryKeys.members(groupId) })
      // The newly created invite must also appear in the admin's invite
      // list in GroupMembersAndInvitesPanel without a manual refetch.
      void client.invalidateQueries({ queryKey: groupQueryKeys.groupInvites(groupId) })
    },
  })
}

/**
 * Revoke a pending GroupInvite (admin-only on the backend). Takes the
 * invite id as the mutation variable. Invalidates the owning group's
 * invite list so the panel refetches.
 */
export function useRevokeInvite(groupId: string) {
  const client = useQueryClient()
  return useMutation<void, Error, string>({
    mutationFn: revokeGroupInvite,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: groupQueryKeys.groupInvites(groupId) })
    },
  })
}

export function useAcceptInvite() {
  const client = useQueryClient()
  return useMutation<GroupInviteCreated, Error, string>({
    mutationFn: acceptGroupInvite,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: groupQueryKeys.invitesReceived() })
      void client.invalidateQueries({ queryKey: groupQueryKeys.mine() })
    },
  })
}

export function useDeclineInvite() {
  const client = useQueryClient()
  return useMutation<GroupInviteCreated, Error, string>({
    mutationFn: declineGroupInvite,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: groupQueryKeys.invitesReceived() })
    },
  })
}

export function useChangeMemberRole(groupId: string) {
  const client = useQueryClient()
  return useMutation<GroupMember, Error, { userId: string; role: GroupRole }>({
    mutationFn: ({ userId, role }) => updateGroupMemberRole(groupId, userId, role),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: groupQueryKeys.detail(groupId) })
      void client.invalidateQueries({ queryKey: groupQueryKeys.members(groupId) })
    },
  })
}

export function useRemoveMember(groupId: string) {
  const client = useQueryClient()
  return useMutation<void, Error, string>({
    mutationFn: (userId) => removeGroupMember(groupId, userId),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: groupQueryKeys.detail(groupId) })
      void client.invalidateQueries({ queryKey: groupQueryKeys.members(groupId) })
      void client.invalidateQueries({ queryKey: groupQueryKeys.mine() })
    },
  })
}
