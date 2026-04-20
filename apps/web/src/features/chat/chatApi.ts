import type {
  ApiError,
  ChatMessage,
  ChatTurnRequest,
  ChatTurnResponse,
  ExtractionResult,
} from '@familien-kochbuch/shared'
import { apiClient } from '@/features/auth/apiClient'

/**
 * Thin HTTP layer for the P2-9 AI chat feature.
 *
 * Talks to the P2-6 bridge endpoints — see `ChatEndpoints.cs`:
 *   - POST /api/chat                          → one conversational turn.
 *   - POST /api/chat/:sessionId/to-recipe     → condense the dialogue
 *                                               into an ExtractionResult.
 *
 * Both calls are synchronous proxies (no Hangfire polling loop); a chat
 * turn typically completes in < 5 s, the to-recipe structuring call
 * in 2–10 s. The `ExtractionResult` response shape is shared with the
 * URL / photo import flows so `RecipeFormPage` can seed from any of the
 * three AI paths without branching on source.
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
 * Wire shape of `POST /api/chat` — the .NET bridge forwards the Python
 * body verbatim, and Python emits snake_case (`assistant_message`). We
 * normalise at the edge (analogue to `importsApi.mapStatusResponse`)
 * so the React layer stays on the camelCase `ChatTurnResponse` surface.
 * BUG-026: without this mapper `res.assistantMessage` was `undefined`,
 * the assistant bubble rendered empty, and the next turn's history
 * carried a `content: undefined` entry that the backend rejected as
 * `invalid_message`.
 */
interface ChatTurnResponseWire {
  assistant_message: string
}

/**
 * One conversational turn. The caller owns the full `messages[]` array
 * — the backend is stateless (P2-4) and needs the complete history on
 * every call. `sessionId` exists purely for logging correlation + the
 * URL `?session=…` binding on the client side.
 */
export async function sendChatTurn(
  body: ChatTurnRequest,
): Promise<ChatTurnResponse> {
  const wire = await request<ChatTurnResponseWire>('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { assistantMessage: wire.assistant_message }
}

/**
 * Condense the current dialogue into a structured recipe. The session
 * id rides in the URL path (matches Python's route shape + the .NET
 * bridge). Response reuses `ExtractionResult` so the P2-9 handoff into
 * `RecipeFormPage` mirrors the URL + photo import flows.
 */
export async function convertChatToRecipe(
  sessionId: string,
  messages: ChatMessage[],
): Promise<ExtractionResult> {
  const encoded = encodeURIComponent(sessionId)
  return request<ExtractionResult>(`/api/chat/${encoded}/to-recipe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  })
}
