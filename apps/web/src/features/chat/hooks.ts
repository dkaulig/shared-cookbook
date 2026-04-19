import { useMutation } from '@tanstack/react-query'
import type {
  ChatMessage,
  ChatTurnRequest,
  ChatTurnResponse,
  ExtractionResult,
} from '@familien-kochbuch/shared'
import { convertChatToRecipe, sendChatTurn } from './chatApi'

/**
 * Mutation wrapper around `POST /api/chat` — one conversational turn.
 *
 * The caller is `ChatPage`, which owns the full `messages[]` state and
 * drives the optimistic user-bubble render before the mutation fires.
 * TanStack's `mutateAsync` throws on HTTP error, so the page can
 * rollback the optimistic bubble + surface a retry affordance.
 */
export function useChatTurn() {
  return useMutation<ChatTurnResponse, Error, ChatTurnRequest>({
    mutationFn: (body) => sendChatTurn(body),
  })
}

/**
 * Mutation wrapper around `POST /api/chat/:sessionId/to-recipe`.
 *
 * Returns the same `ExtractionResult` shape the URL + photo import
 * flows emit, so the downstream handoff into `RecipeFormPage` (via
 * sessionStorage + `?chatImportId=<id>`) can reuse the existing
 * `extractedRecipeToPrefill` helper without branching on source.
 */
export function useConvertChatToRecipe() {
  return useMutation<
    ExtractionResult,
    Error,
    { sessionId: string; messages: ChatMessage[] }
  >({
    mutationFn: ({ sessionId, messages }) =>
      convertChatToRecipe(sessionId, messages),
  })
}
