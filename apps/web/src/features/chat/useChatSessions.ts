import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  ChatMessageDto,
  ChatSessionListItem,
  CreateSessionResponse,
} from '@shared-cookbook/shared'
import {
  createChatSession,
  deleteChatSession,
  fetchChatMessages,
  fetchChatSessions,
  renameChatSession,
} from './chatApi'

/**
 * CR3 — TanStack-Query wrappers for the CR2 chat-session REST surface.
 *
 * Query-key shape:
 *   - `['chat', 'sessions', { limit }]` — the newest-first list index.
 *     The limit is part of the key so `useChatSessions(20)` and
 *     `useChatSessions(50)` don't clobber each other.
 *   - `['chat', 'messages', sessionId]` — one session's history.
 *
 * OFF1 interaction: the `queryPersister` predicate dehydrates the
 * sessions-LIST entry (useful offline — "show me my conversations even
 * when the WiFi is out") but skips every other chat-* key so mid-stream
 * message bodies don't get resurrected after a reload. See
 * {@link file://./lib/queryPersister.ts}.
 */

export const CHAT_SESSIONS_DEFAULT_LIMIT = 20

export const chatQueryKeys = {
  all: ['chat'] as const,
  sessions: (limit: number) =>
    [...chatQueryKeys.all, 'sessions', { limit }] as const,
  messages: (sessionId: string) =>
    [...chatQueryKeys.all, 'messages', sessionId] as const,
}

/**
 * List the caller's sessions, newest-first. Refetch on every page
 * mount (staleTime of 10s matches the rest of the app's list caches —
 * enough to feel instant when flipping between views, short enough
 * that rename/delete propagation from other tabs lands within a tab
 * switch or two).
 */
export function useChatSessions(limit = CHAT_SESSIONS_DEFAULT_LIMIT) {
  return useQuery<ChatSessionListItem[]>({
    queryKey: chatQueryKeys.sessions(limit),
    queryFn: () => fetchChatSessions(limit),
    staleTime: 10_000,
  })
}

/**
 * Load one session's message history. Disabled when `sessionId` is
 * undefined so the hook is safe to call from within route transitions
 * where the URL param hasn't materialised yet.
 */
export function useChatMessages(
  sessionId: string | undefined,
  limit = 200,
) {
  return useQuery<ChatMessageDto[]>({
    queryKey: sessionId
      ? chatQueryKeys.messages(sessionId)
      : ([...chatQueryKeys.all, 'messages', 'disabled'] as const),
    queryFn: () => fetchChatMessages(sessionId!, limit),
    enabled: !!sessionId,
    // No staleTime bump — the message list is append-only but the
    // background auto-title fire-and-forget flips `session.title`
    // without touching the messages list, so a normal refetch on
    // focus is cheap and keeps list+detail roughly aligned.
  })
}

/**
 * Create an empty session. The caller owns navigation (the hook just
 * primes the list cache so a subsequent visit to `/chat` renders the
 * new session without a round-trip).
 */
export function useCreateChatSession() {
  const queryClient = useQueryClient()
  return useMutation<CreateSessionResponse, Error, void>({
    mutationFn: () => createChatSession(),
    onSuccess: (response) => {
      const nowIso = new Date().toISOString()
      const newRow: ChatSessionListItem = {
        id: response.sessionId,
        title: null,
        messageCount: 0,
        createdAt: nowIso,
        updatedAt: nowIso,
      }
      queryClient.setQueryData<ChatSessionListItem[] | undefined>(
        chatQueryKeys.sessions(CHAT_SESSIONS_DEFAULT_LIMIT),
        (old) => (old ? [newRow, ...old] : [newRow]),
      )
    },
  })
}

/**
 * Rename a session. Uses an optimistic cache update with rollback on
 * error so the list row updates instantly (the PATCH is a 204 with no
 * body to hydrate from — no point waiting).
 */
export function useRenameChatSession() {
  const queryClient = useQueryClient()
  return useMutation<
    void,
    Error,
    { sessionId: string; title: string },
    { previous: ChatSessionListItem[] | undefined; key: readonly unknown[] }
  >({
    mutationFn: ({ sessionId, title }) =>
      renameChatSession(sessionId, title),
    onMutate: async ({ sessionId, title }) => {
      const key = chatQueryKeys.sessions(CHAT_SESSIONS_DEFAULT_LIMIT)
      await queryClient.cancelQueries({ queryKey: key })
      const previous = queryClient.getQueryData<ChatSessionListItem[]>(key)
      if (previous) {
        queryClient.setQueryData<ChatSessionListItem[]>(
          key,
          previous.map((row) =>
            row.id === sessionId ? { ...row, title } : row,
          ),
        )
      }
      return { previous, key }
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) {
        queryClient.setQueryData(ctx.key, ctx.previous)
      }
    },
    onSettled: () => {
      // Server may have trimmed/normalised the title — refetch to reconcile.
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.sessions(CHAT_SESSIONS_DEFAULT_LIMIT),
      })
    },
  })
}

/**
 * Delete a session. Optimistically drops the row from the list cache
 * + evicts any cached messages for that id so a subsequent resume
 * attempt 404s cleanly instead of re-rendering phantom content.
 */
export function useDeleteChatSession() {
  const queryClient = useQueryClient()
  return useMutation<
    void,
    Error,
    { sessionId: string },
    { previous: ChatSessionListItem[] | undefined; key: readonly unknown[] }
  >({
    mutationFn: ({ sessionId }) => deleteChatSession(sessionId),
    onMutate: async ({ sessionId }) => {
      const key = chatQueryKeys.sessions(CHAT_SESSIONS_DEFAULT_LIMIT)
      await queryClient.cancelQueries({ queryKey: key })
      const previous = queryClient.getQueryData<ChatSessionListItem[]>(key)
      if (previous) {
        queryClient.setQueryData<ChatSessionListItem[]>(
          key,
          previous.filter((row) => row.id !== sessionId),
        )
      }
      queryClient.removeQueries({
        queryKey: chatQueryKeys.messages(sessionId),
      })
      return { previous, key }
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) {
        queryClient.setQueryData(ctx.key, ctx.previous)
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.sessions(CHAT_SESSIONS_DEFAULT_LIMIT),
      })
    },
  })
}
