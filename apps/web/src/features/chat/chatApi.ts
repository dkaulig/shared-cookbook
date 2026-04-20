import type {
  ApiError,
  ChatMessageDto,
  ChatSessionListItem,
  CreateSessionResponse,
  ExtractionResult,
} from '@familien-kochbuch/shared'
import { apiClient } from '@/features/auth/apiClient'

/**
 * Thin HTTP layer for the AI chat feature.
 *
 * CR2 — the .NET side swapped from a Python-proxy POST /api/chat to a
 * full session-aware surface with SSE streaming. The new endpoints
 * (session list / create / rename / delete / load-messages / turn / to-
 * recipe) all live at `/api/chat/sessions/...` and the previous
 * `POST /api/chat` single-turn call no longer exists.
 *
 * CR3 — adds the REST half of the sessions surface (list/create/rename/
 * delete/messages). The streaming consumer (`POST …/turn`) lands in CR4.
 *
 * The {@link sendChatTurn} legacy helper stays as a compat shim so the
 * pre-CR4 ChatPage keeps sending turns via the soon-to-be-removed
 * `POST /api/chat` path while CR3 focuses on the list + resume flow.
 */

async function request<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await apiClient(input, init)
  if (!response.ok) {
    await throwApiError(response)
  }
  if (response.status === 204 || response.headers.get('Content-Length') === '0') {
    return undefined as unknown as T
  }
  return (await response.json()) as T
}

async function throwApiError(response: Response): Promise<never> {
  let payload: ApiError | null = null
  try {
    payload = (await response.json()) as ApiError
  } catch {
    /* non-JSON body — fall through. */
  }
  const code = payload?.code ?? `http_${response.status}`
  const message = payload?.message ?? response.statusText
  const err = new Error(`${code}: ${message}`) as Error & ApiError
  err.code = code
  err.message = message
  throw err
}

/**
 * Local placeholder type — the old shared `ChatTurnResponse` is gone
 * after CR2. Kept here so the existing `ChatPage.tsx` + its tests can
 * reference a camelCase envelope; CR4 deletes both the helper and the
 * consumer in one commit.
 */
export interface LegacyChatTurnResponse {
  assistantMessage: string
}

/**
 * Local placeholder role union — the shared `ChatMessage` type was
 * renamed to `ChatMessageDto` in CR2. `ChatPage` still speaks in the
 * legacy role/content pair until CR4.
 */
export interface LegacyChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * Legacy body of the removed `POST /api/chat`.
 */
export interface LegacyChatTurnRequest {
  sessionId: string
  messages: LegacyChatMessage[]
}

/**
 * @deprecated CR2 removed `POST /api/chat`. CR4 replaces the whole
 * chat UI with an SSE-streaming consumer against the new
 * `/api/chat/sessions/{id}/turn` endpoint. This function is retained
 * only so the pre-CR4 `ChatPage.tsx` + its tests keep compiling; it
 * will 404 at runtime against a CR2 backend.
 */
export async function sendChatTurn(
  body: LegacyChatTurnRequest,
): Promise<LegacyChatTurnResponse> {
  const wire = await request<{ assistant_message: string }>('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { assistantMessage: wire.assistant_message }
}

/**
 * Condense the current dialogue into a structured recipe. CR2 moved
 * the message-source from the request body to DB-side load — the
 * frontend only passes the `sessionId` now. Response still reuses
 * {@link ExtractionResult} so the P2-9 handoff into `RecipeFormPage`
 * keeps working once CR4 lands.
 */
export async function convertChatToRecipe(
  sessionId: string,
): Promise<ExtractionResult> {
  const encoded = encodeURIComponent(sessionId)
  return request<ExtractionResult>(`/api/chat/sessions/${encoded}/to-recipe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })
}

// ── CR3 session-list surface ────────────────────────────────────────

/**
 * GET `/api/chat/sessions?limit=<n>` — newest-first list of the
 * caller's sessions. The server defaults to 20; we pass it explicitly
 * so the query-key matches 1:1 what TanStack sees.
 */
export async function fetchChatSessions(
  limit: number,
): Promise<ChatSessionListItem[]> {
  const qs = new URLSearchParams({ limit: String(limit) })
  return request<ChatSessionListItem[]>(`/api/chat/sessions?${qs.toString()}`, {
    method: 'GET',
  })
}

/**
 * POST `/api/chat/sessions` — create a fresh empty session. Response
 * returns `{ sessionId }` only; the caller navigates to
 * `/chat/<sessionId>` which renders the empty shell.
 */
export async function createChatSession(): Promise<CreateSessionResponse> {
  return request<CreateSessionResponse>(`/api/chat/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * PATCH `/api/chat/sessions/:id` — rename via `{ title }`. 204 on
 * success.
 */
export async function renameChatSession(
  sessionId: string,
  title: string,
): Promise<void> {
  const encoded = encodeURIComponent(sessionId)
  await request<void>(`/api/chat/sessions/${encoded}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
}

/**
 * DELETE `/api/chat/sessions/:id` — hard delete (or soft, per CR1).
 * 204 on success.
 */
export async function deleteChatSession(sessionId: string): Promise<void> {
  const encoded = encodeURIComponent(sessionId)
  await request<void>(`/api/chat/sessions/${encoded}`, {
    method: 'DELETE',
  })
}

/**
 * GET `/api/chat/sessions/:id/messages?limit=<n>` — load a session's
 * message history, ASC by creation time. Server defaults to the last
 * 200 messages; the CR plan pins 200 as the default cap.
 */
export async function fetchChatMessages(
  sessionId: string,
  limit = 200,
): Promise<ChatMessageDto[]> {
  const encoded = encodeURIComponent(sessionId)
  const qs = new URLSearchParams({ limit: String(limit) })
  return request<ChatMessageDto[]>(
    `/api/chat/sessions/${encoded}/messages?${qs.toString()}`,
    { method: 'GET' },
  )
}
