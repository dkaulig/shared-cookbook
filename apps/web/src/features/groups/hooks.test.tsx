import type { ReactNode } from 'react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import {
  useAcceptInvite,
  useCreateGroup,
  useGroupInvites,
  useInviteToGroup,
  useMyReceivedInvites,
  useRevokeInvite,
} from './hooks'
import { groupQueryKeys } from './queryKeys'

function setupClient(): { client: QueryClient; Wrapper: (p: { children: ReactNode }) => ReactNode } {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
  return { client, Wrapper }
}

describe('group hooks', () => {
  beforeEach(() => {
    useAuthStore.getState().setSession('tok', {
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

  it('useCreateGroup POSTs and invalidates [groups, mine] on success', async () => {
    server.use(
      http.post('/api/groups', () =>
        HttpResponse.json(
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
          { status: 201 },
        ),
      ),
    )

    const { client, Wrapper } = setupClient()
    // Seed a stale list so we can verify invalidation kicks the query out of fresh state.
    client.setQueryData(groupQueryKeys.mine(), [])

    const { result } = renderHook(() => useCreateGroup(), { wrapper: Wrapper })

    let mutationResult: Awaited<ReturnType<typeof result.current.mutateAsync>> | null = null
    await act(async () => {
      mutationResult = await result.current.mutateAsync({ name: 'Familie' })
    })

    expect(mutationResult).not.toBeNull()
    expect(mutationResult?.id).toBe('g1')
    await waitFor(() => {
      const state = client.getQueryState(groupQueryKeys.mine())
      expect(state?.isInvalidated).toBe(true)
    })
  })

  it('useInviteToGroup POSTs and invalidates the group detail cache', async () => {
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

    const { client, Wrapper } = setupClient()
    client.setQueryData(groupQueryKeys.detail('g1'), {
      id: 'g1',
      name: 'Familie',
      description: null,
      coverImageUrl: null,
      defaultServings: 2,
      isPrivateCollection: false,
      memberCount: 1,
      myRole: 'Admin',
      members: [],
    })

    const { result } = renderHook(() => useInviteToGroup('g1'), { wrapper: Wrapper })

    let mutationResult: Awaited<ReturnType<typeof result.current.mutateAsync>> | null = null
    await act(async () => {
      mutationResult = await result.current.mutateAsync({ invitedUserId: 'u2' })
    })

    expect(mutationResult?.id).toBe('i1')
    await waitFor(() => {
      const state = client.getQueryState(groupQueryKeys.detail('g1'))
      expect(state?.isInvalidated).toBe(true)
    })
  })

  it('useMyReceivedInvites uses the shared cache key', async () => {
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

    const { client, Wrapper } = setupClient()
    const { result } = renderHook(() => useMyReceivedInvites(), { wrapper: Wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toHaveLength(1)

    const cached = client.getQueryData(groupQueryKeys.invitesReceived())
    expect(cached).toEqual(result.current.data)
  })

  it('useGroupInvites fetches /api/groups/:id/invites and caches under groupInvites(id)', async () => {
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

    const { client, Wrapper } = setupClient()
    const { result } = renderHook(() => useGroupInvites('g1'), { wrapper: Wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toHaveLength(1)
    expect(result.current.data?.[0]?.invitedUserDisplayName).toBe('Bob')

    const cached = client.getQueryData(groupQueryKeys.groupInvites('g1'))
    expect(cached).toEqual(result.current.data)
  })

  it('useGroupInvites is disabled when groupId is undefined', () => {
    const { Wrapper } = setupClient()
    const { result } = renderHook(() => useGroupInvites(undefined), { wrapper: Wrapper })
    expect(result.current.isFetching).toBe(false)
    expect(result.current.isSuccess).toBe(false)
  })

  it('useRevokeInvite DELETEs and invalidates groupInvites(groupId)', async () => {
    server.use(
      http.delete('/api/groups/invites/i1', () => HttpResponse.json(null, { status: 204 })),
    )

    const { client, Wrapper } = setupClient()
    client.setQueryData(groupQueryKeys.groupInvites('g1'), [
      {
        id: 'i1',
        groupId: 'g1',
        invitedUserId: 'u2',
        invitedUserDisplayName: 'Bob',
        status: 'Pending',
        createdAt: new Date().toISOString(),
      },
    ])

    const { result } = renderHook(() => useRevokeInvite('g1'), { wrapper: Wrapper })
    await act(async () => {
      await result.current.mutateAsync('i1')
    })

    await waitFor(() => {
      const state = client.getQueryState(groupQueryKeys.groupInvites('g1'))
      expect(state?.isInvalidated).toBe(true)
    })
  })

  it('useAcceptInvite invalidates the received-invites list so the banner hides', async () => {
    server.use(
      http.post('/api/groups/invites/i1/accept', () =>
        HttpResponse.json({
          id: 'i1',
          groupId: 'g1',
          invitedUserId: 'u1',
          status: 'Accepted',
          createdAt: new Date().toISOString(),
        }),
      ),
    )
    const { client, Wrapper } = setupClient()
    client.setQueryData(groupQueryKeys.invitesReceived(), [
      {
        id: 'i1',
        groupId: 'g1',
        groupName: 'Familie',
        inviterDisplayName: 'Alice',
        createdAt: new Date().toISOString(),
      },
    ])
    const { result } = renderHook(() => useAcceptInvite(), { wrapper: Wrapper })

    await act(async () => {
      await result.current.mutateAsync('i1')
    })

    const state = client.getQueryState(groupQueryKeys.invitesReceived())
    expect(state?.isInvalidated).toBe(true)
  })
})
