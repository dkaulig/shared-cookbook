import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import type { ReactNode } from 'react'
import { http, HttpResponse } from 'msw'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ChatSessionListItem } from '@shared-cookbook/shared'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import {
  chatQueryKeys,
  useChatMessages,
  useChatSessions,
  useCreateChatSession,
  useDeleteChatSession,
  useRenameChatSession,
} from './useChatSessions'

/**
 * CR3 — contract tests for the sessions-list hook family. Exercises
 * the round-trip fetch, optimistic mutations, and cache update paths.
 */

function makeWrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
}

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  })
}

function row(over: Partial<ChatSessionListItem> = {}): ChatSessionListItem {
  return {
    id: 's1',
    title: null,
    messageCount: 0,
    createdAt: '2026-04-20T10:00:00Z',
    updatedAt: '2026-04-20T10:00:00Z',
    ...over,
  }
}

beforeEach(() => {
  useAuthStore.setState({
    accessToken: 't',
    user: { id: 'u1', email: 'u1@ex.com', displayName: 'U', role: 'User' },
  })
})

afterEach(() => {
  server.resetHandlers()
  useAuthStore.getState().clear()
})

describe('useChatSessions', () => {
  it('fetches and returns the sessions list', async () => {
    server.use(
      http.get('/api/chat/sessions', () =>
        HttpResponse.json<ChatSessionListItem[]>([
          row({ id: 's1', title: 'Erste' }),
          row({ id: 's2', title: 'Zweite' }),
        ]),
      ),
    )
    const { result } = renderHook(() => useChatSessions(), {
      wrapper: makeWrapper(makeClient()),
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toHaveLength(2)
    expect(result.current.data?.[0]?.title).toBe('Erste')
  })

  it('passes the limit query-param and uses it as part of the query key', async () => {
    let capturedLimit = ''
    server.use(
      http.get('/api/chat/sessions', ({ request }) => {
        capturedLimit = new URL(request.url).searchParams.get('limit') ?? ''
        return HttpResponse.json<ChatSessionListItem[]>([])
      }),
    )
    const client = makeClient()
    renderHook(() => useChatSessions(50), {
      wrapper: makeWrapper(client),
    })
    await waitFor(() => expect(capturedLimit).toBe('50'))
    expect(client.getQueryData(chatQueryKeys.sessions(50))).toEqual([])
  })

  it('surfaces backend errors via isError', async () => {
    server.use(
      http.get('/api/chat/sessions', () =>
        HttpResponse.json(
          { code: 'forbidden', message: 'Nope.' },
          { status: 403 },
        ),
      ),
    )
    const { result } = renderHook(() => useChatSessions(), {
      wrapper: makeWrapper(makeClient()),
    })
    await waitFor(() => expect(result.current.isError).toBe(true))
  })
})

describe('useCreateChatSession', () => {
  it('POSTs and prepends the new row into the sessions-list cache', async () => {
    server.use(
      http.post('/api/chat/sessions', () =>
        HttpResponse.json({ sessionId: 'new-session-id' }),
      ),
    )
    const client = makeClient()
    // Seed existing cache so we can assert the prepend.
    client.setQueryData<ChatSessionListItem[]>(
      chatQueryKeys.sessions(20),
      [row({ id: 'old', title: 'Old' })],
    )
    const { result } = renderHook(() => useCreateChatSession(), {
      wrapper: makeWrapper(client),
    })
    const res = await result.current.mutateAsync()
    expect(res.sessionId).toBe('new-session-id')
    const list = client.getQueryData<ChatSessionListItem[]>(
      chatQueryKeys.sessions(20),
    )
    expect(list).toHaveLength(2)
    expect(list?.[0]?.id).toBe('new-session-id')
    expect(list?.[0]?.title).toBeNull()
  })
})

describe('useRenameChatSession', () => {
  it('optimistically updates the row then confirms on 204', async () => {
    server.use(
      http.patch('/api/chat/sessions/:sessionId', () =>
        new HttpResponse(null, { status: 204 }),
      ),
      // Invalidation will re-fetch; return the renamed row.
      http.get('/api/chat/sessions', () =>
        HttpResponse.json<ChatSessionListItem[]>([
          row({ id: 's1', title: 'Neuer Titel' }),
        ]),
      ),
    )
    const client = makeClient()
    client.setQueryData<ChatSessionListItem[]>(
      chatQueryKeys.sessions(20),
      [row({ id: 's1', title: 'Alt' })],
    )
    const { result } = renderHook(() => useRenameChatSession(), {
      wrapper: makeWrapper(client),
    })
    const pending = result.current.mutateAsync({
      sessionId: 's1',
      title: 'Neuer Titel',
    })
    // Optimistic write should be visible immediately.
    await waitFor(() => {
      const list = client.getQueryData<ChatSessionListItem[]>(
        chatQueryKeys.sessions(20),
      )
      expect(list?.[0]?.title).toBe('Neuer Titel')
    })
    await pending
  })

  it('rolls back the optimistic title on error', async () => {
    server.use(
      http.patch('/api/chat/sessions/:sessionId', () =>
        HttpResponse.json(
          { code: 'invalid_title', message: 'Titel zu lang.' },
          { status: 400 },
        ),
      ),
      http.get('/api/chat/sessions', () =>
        HttpResponse.json<ChatSessionListItem[]>([
          row({ id: 's1', title: 'Alt' }),
        ]),
      ),
    )
    const client = makeClient()
    client.setQueryData<ChatSessionListItem[]>(
      chatQueryKeys.sessions(20),
      [row({ id: 's1', title: 'Alt' })],
    )
    const { result } = renderHook(() => useRenameChatSession(), {
      wrapper: makeWrapper(client),
    })
    await expect(
      result.current.mutateAsync({ sessionId: 's1', title: 'X' }),
    ).rejects.toBeDefined()
    // Rollback should restore the previous title.
    await waitFor(() => {
      const list = client.getQueryData<ChatSessionListItem[]>(
        chatQueryKeys.sessions(20),
      )
      expect(list?.[0]?.title).toBe('Alt')
    })
  })
})

describe('useDeleteChatSession', () => {
  it('drops the row optimistically and evicts cached messages for the id', async () => {
    server.use(
      http.delete('/api/chat/sessions/:sessionId', () =>
        new HttpResponse(null, { status: 204 }),
      ),
      http.get('/api/chat/sessions', () =>
        HttpResponse.json<ChatSessionListItem[]>([row({ id: 's2' })]),
      ),
    )
    const client = makeClient()
    client.setQueryData<ChatSessionListItem[]>(
      chatQueryKeys.sessions(20),
      [row({ id: 's1' }), row({ id: 's2' })],
    )
    client.setQueryData(chatQueryKeys.messages('s1'), [
      { id: 'm1', role: 'user', content: 'hi', createdAt: 'now' },
    ])
    const { result } = renderHook(() => useDeleteChatSession(), {
      wrapper: makeWrapper(client),
    })
    await result.current.mutateAsync({ sessionId: 's1' })
    const list = client.getQueryData<ChatSessionListItem[]>(
      chatQueryKeys.sessions(20),
    )
    expect(list?.map((r) => r.id)).toEqual(['s2'])
    expect(client.getQueryData(chatQueryKeys.messages('s1'))).toBeUndefined()
  })

  it('rolls back the optimistic drop on error', async () => {
    server.use(
      http.delete('/api/chat/sessions/:sessionId', () =>
        HttpResponse.json(
          { code: 'forbidden', message: 'nope' },
          { status: 403 },
        ),
      ),
      http.get('/api/chat/sessions', () =>
        HttpResponse.json<ChatSessionListItem[]>([
          row({ id: 's1' }),
          row({ id: 's2' }),
        ]),
      ),
    )
    const client = makeClient()
    client.setQueryData<ChatSessionListItem[]>(
      chatQueryKeys.sessions(20),
      [row({ id: 's1' }), row({ id: 's2' })],
    )
    const { result } = renderHook(() => useDeleteChatSession(), {
      wrapper: makeWrapper(client),
    })
    await expect(
      result.current.mutateAsync({ sessionId: 's1' }),
    ).rejects.toBeDefined()
    await waitFor(() => {
      const list = client.getQueryData<ChatSessionListItem[]>(
        chatQueryKeys.sessions(20),
      )
      expect(list?.map((r) => r.id)).toEqual(['s1', 's2'])
    })
  })
})

describe('useChatMessages', () => {
  it('fetches message history for a given sessionId', async () => {
    server.use(
      http.get('/api/chat/sessions/:sessionId/messages', ({ params }) =>
        HttpResponse.json([
          {
            id: 'm1',
            role: 'user',
            content: `for ${params.sessionId}`,
            createdAt: '2026-04-20T10:00:00Z',
          },
        ]),
      ),
    )
    const { result } = renderHook(() => useChatMessages('s1'), {
      wrapper: makeWrapper(makeClient()),
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.[0]?.content).toBe('for s1')
  })

  it('is disabled when sessionId is undefined (no network, no query)', async () => {
    let called = 0
    server.use(
      http.get('/api/chat/sessions/:sessionId/messages', () => {
        called += 1
        return HttpResponse.json([])
      }),
    )
    const { result } = renderHook(() => useChatMessages(undefined), {
      wrapper: makeWrapper(makeClient()),
    })
    // TanStack sets status='pending' fetchStatus='idle' when disabled.
    expect(result.current.fetchStatus).toBe('idle')
    expect(called).toBe(0)
  })
})
