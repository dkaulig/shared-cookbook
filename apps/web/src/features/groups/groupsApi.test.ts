import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import {
  acceptGroupInvite,
  createGroup,
  createGroupInvite,
  declineGroupInvite,
  deleteGroup,
  fetchGroupDetail,
  fetchGroupInvites,
  fetchMyGroups,
  fetchReceivedInvites,
  removeGroupMember,
  revokeGroupInvite,
  searchUsers,
  updateGroup,
  updateGroupMemberRole,
} from './groupsApi'

describe('groupsApi', () => {
  beforeEach(() => {
    useAuthStore.getState().setSession('test-access-token', {
      id: 'u1',
      email: 'x@y.de',
      displayName: 'X',
      role: 'User',
    })
  })

  afterEach(() => {
    server.resetHandlers()
    useAuthStore.getState().clear()
  })

  it('fetchMyGroups GETs /api/groups and returns parsed array', async () => {
    server.use(
      http.get('/api/groups', () =>
        HttpResponse.json([
          {
            id: 'g1',
            name: 'Familie',
            description: null,
            coverImageUrl: null,
            defaultServings: 2,
            isPrivateCollection: false,
            memberCount: 1,
            myRole: 'Admin',
          },
        ]),
      ),
    )

    const groups = await fetchMyGroups()
    expect(groups).toHaveLength(1)
    expect(groups[0]?.name).toBe('Familie')
  })

  it('createGroup POSTs the body as JSON', async () => {
    let received: unknown
    server.use(
      http.post('/api/groups', async ({ request }) => {
        received = await request.json()
        return HttpResponse.json(
          {
            id: 'new',
            name: 'Neu',
            description: null,
            coverImageUrl: null,
            defaultServings: 2,
            isPrivateCollection: false,
            memberCount: 1,
            myRole: 'Admin',
          },
          { status: 201 },
        )
      }),
    )

    const created = await createGroup({ name: 'Neu' })
    expect(received).toEqual({ name: 'Neu' })
    expect(created.id).toBe('new')
  })

  it('createGroup throws an ApiError on non-2xx with server code + message', async () => {
    server.use(
      http.post('/api/groups', () =>
        HttpResponse.json(
          { code: 'invalid_input', message: 'Name darf nicht leer sein.' },
          { status: 400 },
        ),
      ),
    )

    await expect(createGroup({ name: '   ' })).rejects.toMatchObject({
      code: 'invalid_input',
      message: 'Name darf nicht leer sein.',
    })
  })

  it('fetchGroupDetail GETs /api/groups/:id', async () => {
    server.use(
      http.get('/api/groups/abc', () =>
        HttpResponse.json({
          id: 'abc',
          name: 'Familie',
          description: null,
          coverImageUrl: null,
          defaultServings: 2,
          isPrivateCollection: false,
          memberCount: 2,
          myRole: 'Admin',
          members: [
            { userId: 'u1', displayName: 'Ich', role: 'Admin', joinedAt: '2026-04-17' },
          ],
        }),
      ),
    )

    const detail = await fetchGroupDetail('abc')
    expect(detail.members).toHaveLength(1)
  })

  it('updateGroup PUTs the body', async () => {
    server.use(
      http.put('/api/groups/abc', async () =>
        HttpResponse.json({
          id: 'abc',
          name: 'Renamed',
          description: null,
          coverImageUrl: null,
          defaultServings: 2,
          isPrivateCollection: false,
          memberCount: 1,
          myRole: 'Admin',
        }),
      ),
    )
    const result = await updateGroup('abc', { name: 'Renamed' })
    expect(result.name).toBe('Renamed')
  })

  it('deleteGroup DELETEs /api/groups/:id', async () => {
    let called = false
    server.use(
      http.delete('/api/groups/abc', () => {
        called = true
        return new HttpResponse(null, { status: 204 })
      }),
    )
    await deleteGroup('abc')
    expect(called).toBe(true)
  })

  it('createGroupInvite POSTs to /api/groups/:id/invites', async () => {
    server.use(
      http.post('/api/groups/g1/invites', () =>
        HttpResponse.json(
          {
            id: 'i1',
            groupId: 'g1',
            invitedUserId: 'u2',
            status: 'Pending',
            createdAt: new Date().toISOString(),
          },
          { status: 201 },
        ),
      ),
    )
    const invite = await createGroupInvite('g1', { invitedUserId: 'u2' })
    expect(invite.id).toBe('i1')
  })

  it('fetchReceivedInvites returns pending invites array', async () => {
    server.use(
      http.get('/api/groups/invites', () =>
        HttpResponse.json([
          {
            id: 'i1',
            groupId: 'g1',
            groupName: 'Familie',
            inviterDisplayName: 'Alice',
            createdAt: new Date().toISOString(),
          },
        ]),
      ),
    )
    const invites = await fetchReceivedInvites()
    expect(invites[0]?.groupName).toBe('Familie')
  })

  it('acceptGroupInvite POSTs to /accept', async () => {
    let called = false
    server.use(
      http.post('/api/groups/invites/i1/accept', () => {
        called = true
        return HttpResponse.json({
          id: 'i1',
          groupId: 'g1',
          invitedUserId: 'u2',
          status: 'Accepted',
          createdAt: new Date().toISOString(),
        })
      }),
    )
    await acceptGroupInvite('i1')
    expect(called).toBe(true)
  })

  it('declineGroupInvite POSTs to /decline', async () => {
    let called = false
    server.use(
      http.post('/api/groups/invites/i1/decline', () => {
        called = true
        return HttpResponse.json({
          id: 'i1',
          groupId: 'g1',
          invitedUserId: 'u2',
          status: 'Declined',
          createdAt: new Date().toISOString(),
        })
      }),
    )
    await declineGroupInvite('i1')
    expect(called).toBe(true)
  })

  it('updateGroupMemberRole PUTs the role body', async () => {
    let received: unknown
    server.use(
      http.put('/api/groups/g1/members/u2', async ({ request }) => {
        received = await request.json()
        return HttpResponse.json({
          userId: 'u2',
          displayName: 'Bob',
          role: 'Admin',
          joinedAt: '2026-04-17',
        })
      }),
    )
    await updateGroupMemberRole('g1', 'u2', 'Admin')
    expect(received).toEqual({ role: 'Admin' })
  })

  it('removeGroupMember DELETEs the member', async () => {
    let called = false
    server.use(
      http.delete('/api/groups/g1/members/u2', () => {
        called = true
        return new HttpResponse(null, { status: 204 })
      }),
    )
    await removeGroupMember('g1', 'u2')
    expect(called).toBe(true)
  })

  it('fetchGroupInvites GETs /api/groups/:id/invites', async () => {
    server.use(
      http.get('/api/groups/g1/invites', () =>
        HttpResponse.json([
          {
            id: 'i1',
            groupId: 'g1',
            invitedUserId: 'u2',
            invitedUserDisplayName: 'Bob',
            status: 'Pending',
            createdAt: new Date().toISOString(),
          },
        ]),
      ),
    )
    const invites = await fetchGroupInvites('g1')
    expect(invites).toHaveLength(1)
    expect(invites[0]?.invitedUserDisplayName).toBe('Bob')
  })

  it('revokeGroupInvite DELETEs /api/groups/invites/:id', async () => {
    let called = false
    server.use(
      http.delete('/api/groups/invites/i1', () => {
        called = true
        return new HttpResponse(null, { status: 204 })
      }),
    )
    await revokeGroupInvite('i1')
    expect(called).toBe(true)
  })

  it('searchUsers encodes q and excludeGroupId as query params', async () => {
    let receivedUrl = ''
    server.use(
      http.get('/api/users/search', ({ request }) => {
        receivedUrl = request.url
        return HttpResponse.json([])
      }),
    )
    await searchUsers('Bob', 'g1')
    expect(receivedUrl).toContain('q=Bob')
    expect(receivedUrl).toContain('excludeGroupId=g1')
  })
})
