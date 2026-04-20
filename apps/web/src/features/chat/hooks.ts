import { useMutation } from '@tanstack/react-query'
import type { ExtractionResult } from '@familien-kochbuch/shared'
import {
  convertChatToRecipe,
  sendChatTurn,
  type LegacyChatMessage,
  type LegacyChatTurnRequest,
  type LegacyChatTurnResponse,
} from './chatApi'

/**
 * Mutation wrapper around the legacy `POST /api/chat` — one conversational
 * turn. CR2 removed that endpoint on the backend; the mutation still
 * compiles so `ChatPage.tsx` keeps working until CR4 replaces the UI
 * with an SSE-streaming consumer.
 *
 * @deprecated Replace in CR4 with the streaming SSE consumer.
 */
export function useChatTurn() {
  return useMutation<LegacyChatTurnResponse, Error, LegacyChatTurnRequest>({
    mutationFn: (body) => sendChatTurn(body),
  })
}

/**
 * Mutation wrapper around `POST /api/chat/sessions/:sessionId/to-recipe`.
 *
 * CR2 moved the messages source from the body to the DB — the hook now
 * only carries `sessionId`. Callers that previously passed `messages[]`
 * should drop that argument; it is ignored if still supplied for the
 * transition period.
 */
export function useConvertChatToRecipe() {
  return useMutation<
    ExtractionResult,
    Error,
    { sessionId: string; messages?: LegacyChatMessage[] }
  >({
    mutationFn: ({ sessionId }) => convertChatToRecipe(sessionId),
  })
}
