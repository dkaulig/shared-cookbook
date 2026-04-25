import { useMutation } from '@tanstack/react-query'
import type { ExtractionResult } from '@shared-cookbook/shared'
import { convertChatToRecipe } from './chatApi'

/**
 * Mutation wrapper around `POST /api/chat/sessions/:sessionId/to-recipe`.
 *
 * CR2 moved the messages source from the body to the DB — the hook now
 * only carries `sessionId`.
 *
 * CR4 dropped the legacy `useChatTurn` mutation; turn submission now
 * happens through {@link file://./sseChatStream.ts}'s async-generator
 * consumer wired into ChatPage directly.
 */
export function useConvertChatToRecipe() {
  return useMutation<ExtractionResult, Error, { sessionId: string }>({
    mutationFn: ({ sessionId }) => convertChatToRecipe(sessionId),
  })
}
