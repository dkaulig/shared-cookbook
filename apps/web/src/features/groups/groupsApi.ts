import type {
  ApiError,
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
import { apiClient } from '@/features/auth/apiClient'

/**
 * Typed access layer for the S2 Groups API. All calls go through
 * `apiClient` so Bearer-token injection + silent refresh on 401 are
 * handled in one place. Errors are normalized into a throwable
 * `ApiError`-shaped object so the mutation hooks can render `err.code`
 * / `err.message` without additional parsing.
 */

async function request<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
  emptyResult?: T,
): Promise<T> {
  const response = await apiClient(input, init)
  if (!response.ok) {
    await throwApiError(response)
  }
  if (response.status === 204 || response.headers.get('Content-Length') === '0') {
    return (emptyResult as T) ?? (undefined as unknown as T)
  }
  return (await response.json()) as T
}

async function throwApiError(response: Response): Promise<never> {
  let payload: ApiError | null = null
  try {
    payload = (await response.json()) as ApiError
  } catch {
    // Non-JSON body — fall through to synthetic error.
  }
  const code = payload?.code ?? `http_${response.status}`
  const message = payload?.message ?? response.statusText
  const err = new Error(`${code}: ${message}`) as Error & ApiError
  err.code = code
  err.message = message
  // REL-4: pin status + fieldName from the body so downstream
  // classifiers route by authoritative number.
  err.status = payload?.status ?? response.status
  if (payload?.fieldName) err.fieldName = payload.fieldName
  throw err
}

// ── Groups ──────────────────────────────────────────────────────────

export async function fetchMyGroups(): Promise<GroupSummary[]> {
  return request<GroupSummary[]>('/api/groups')
}

export async function fetchGroupDetail(id: string): Promise<GroupDetail> {
  return request<GroupDetail>(`/api/groups/${encodeURIComponent(id)}`)
}

export async function createGroup(body: CreateGroupRequest): Promise<GroupSummary> {
  return request<GroupSummary>('/api/groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function updateGroup(id: string, body: UpdateGroupRequest): Promise<GroupSummary> {
  return request<GroupSummary>(`/api/groups/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function deleteGroup(id: string): Promise<void> {
  await request<void>(`/api/groups/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// ── Members ─────────────────────────────────────────────────────────

export async function fetchGroupMembers(id: string): Promise<GroupMember[]> {
  return request<GroupMember[]>(`/api/groups/${encodeURIComponent(id)}/members`)
}

export async function updateGroupMemberRole(
  groupId: string,
  userId: string,
  role: GroupRole,
): Promise<GroupMember> {
  return request<GroupMember>(
    `/api/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    },
  )
}

export async function removeGroupMember(groupId: string, userId: string): Promise<void> {
  await request<void>(
    `/api/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`,
    { method: 'DELETE' },
  )
}

// ── Invites ─────────────────────────────────────────────────────────

export async function createGroupInvite(
  groupId: string,
  body: InviteToGroupRequest,
): Promise<GroupInviteCreated> {
  return request<GroupInviteCreated>(
    `/api/groups/${encodeURIComponent(groupId)}/invites`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  )
}

export async function fetchReceivedInvites(): Promise<GroupInviteReceived[]> {
  return request<GroupInviteReceived[]>('/api/groups/invites')
}

export async function fetchGroupInvites(groupId: string): Promise<GroupInviteListItem[]> {
  return request<GroupInviteListItem[]>(
    `/api/groups/${encodeURIComponent(groupId)}/invites`,
  )
}

export async function revokeGroupInvite(inviteId: string): Promise<void> {
  await request<void>(
    `/api/groups/invites/${encodeURIComponent(inviteId)}`,
    { method: 'DELETE' },
  )
}

export async function acceptGroupInvite(inviteId: string): Promise<GroupInviteCreated> {
  return request<GroupInviteCreated>(
    `/api/groups/invites/${encodeURIComponent(inviteId)}/accept`,
    { method: 'POST' },
  )
}

export async function declineGroupInvite(inviteId: string): Promise<GroupInviteCreated> {
  return request<GroupInviteCreated>(
    `/api/groups/invites/${encodeURIComponent(inviteId)}/decline`,
    { method: 'POST' },
  )
}

// ── User search ─────────────────────────────────────────────────────

export async function searchUsers(q: string, excludeGroupId?: string): Promise<UserSearchResult[]> {
  const params = new URLSearchParams({ q })
  if (excludeGroupId) params.set('excludeGroupId', excludeGroupId)
  return request<UserSearchResult[]>(`/api/users/search?${params.toString()}`)
}
