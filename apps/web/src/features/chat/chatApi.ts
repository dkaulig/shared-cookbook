import type {
  ApiError,
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
 * The frontend swap happens in CR4 (streaming consumer + sessions-list
 * UI). This file is currently a type-compat shim: it preserves the
 * existing surface used by `ChatPage.tsx` so the old page keeps
 * compiling until CR4 rewrites it. {@link sendChatTurn} is marked
 * `@deprecated` — it will throw at runtime because `POST /api/chat` no
 * longer exists, but that is acceptable for CR2 because the frontend
 * doesn't actually ship against the new backend until CR4.
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
