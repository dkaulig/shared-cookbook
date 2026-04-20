/**
 * Chat DTOs for the CR2+ AI recipe-chat rebuild.
 *
 * The session surface lives on .NET now (CR2). The client lifecycle:
 *   - `GET  /api/chat/sessions`                     → list caller's sessions
 *   - `POST /api/chat/sessions`                     → create empty session
 *   - `PATCH /api/chat/sessions/{id}`               → rename
 *   - `DELETE /api/chat/sessions/{id}`              → delete
 *   - `GET  /api/chat/sessions/{id}/messages`       → history (ASC)
 *   - `POST /api/chat/sessions/{id}/turn`           → SSE stream of tokens
 *   - `POST /api/chat/sessions/{id}/to-recipe`      → proxy to Python
 *
 * The server-side-prompted `'system'` role is present in
 * {@link ChatRoleWire} because message history reads may include the
 * system prompt row in future; the client-emitted turn request only
 * carries the user's text (role is implicit).
 */

/**
 * Narrow role type used by the client-side bubble rendering. The turn
 * request body does not include a role (the endpoint knows the sender
 * is the authenticated user), so the UI only ever creates `'user'` or
 * `'assistant'` bubbles locally.
 */
export type ChatRole = 'user' | 'assistant'

/**
 * Wire-level role set returned by the messages history endpoint. The
 * `'system'` row is the server-side prompt priming; the UI hides it by
 * default but we keep the type open so a debug surface can opt in.
 */
export type ChatRoleWire = 'user' | 'assistant' | 'system'

/**
 * Row shape for a single message persisted in a {@link ChatSessionListItem}.
 */
export interface ChatMessageDto {
  id: string
  role: ChatRoleWire
  content: string
  /** ISO-8601 UTC timestamp. */
  createdAt: string
}

/**
 * Row in the `GET /api/chat/sessions` response. `title` is `null` until
 * the auto-title service (fire-and-forget post-first-turn) or a manual
 * rename sets it.
 */
export interface ChatSessionListItem {
  id: string
  title: string | null
  messageCount: number
  /** ISO-8601 UTC timestamp. */
  createdAt: string
  /** ISO-8601 UTC timestamp. */
  updatedAt: string
}

/** Body of `POST /api/chat/sessions/{id}/turn`. */
export interface TurnRequest {
  content: string
}

/** Response body of `POST /api/chat/sessions`. */
export interface CreateSessionResponse {
  sessionId: string
}

/** Body of `PATCH /api/chat/sessions/{id}`. */
export interface RenameSessionRequest {
  title: string
}

/**
 * One parsed SSE block the CR4 stream-reader emits. The union narrows
 * by `event`; see the .NET endpoint's event-schema in the CR plan.
 *
 * Callers typically switch on the event name and narrow `data` at each
 * branch — the `unknown` keeps the type-layer free of any coupling to
 * the JSON payload shape (which will evolve alongside the backend).
 */
export interface SseChunk {
  event:
    | 'message-started'
    | 'token'
    | 'usage'
    | 'done'
    | 'heartbeat'
    | 'error'
  data: unknown
}

/** Payload shape for the SSE `message-started` event. */
export interface SseMessageStartedData {
  messageId: string
  role: 'assistant'
}

/** Payload shape for the SSE `token` event. */
export interface SseTokenData {
  text: string
}

/** Payload shape for the SSE `usage` event. */
export interface SseUsageData {
  promptTokens: number
  completionTokens: number
  cachedPromptTokens: number
}

/** Payload shape for the SSE `done` event. */
export interface SseDoneData {
  messageId: string
}

/** Payload shape for the SSE `error` event. */
export interface SseErrorData {
  code: string
  message: string
}
