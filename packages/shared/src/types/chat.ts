/**
 * Chat DTOs for the P2-9 AI recipe-chat feature.
 *
 * The Python extractor exposes two endpoints (P2-4), proxied by .NET
 * (P2-6, see `ChatEndpoints.cs`):
 *   - `POST /api/chat` — one conversational turn. Body carries the full
 *     `messages[]` (backend is stateless — the client resends history
 *     on every turn), plus the client-side `sessionId` for logging
 *     correlation.
 *   - `POST /api/chat/{sessionId}/to-recipe` — condense the current
 *     dialogue into a structured recipe. Response reuses the existing
 *     `ExtractionResult` shape from `imports.ts` so the review surface
 *     (`RecipeFormPage`) can seed from it without a separate code path.
 *
 * The `role: 'system'` the .NET bridge accepts exists for server-side
 * prompt priming only — the web surface only ever emits `user` and
 * `assistant` roles, hence the narrower client-facing `ChatRole` union.
 */

export type ChatRole = 'user' | 'assistant'

export interface ChatMessage {
  role: ChatRole
  content: string
}

/** Body of `POST /api/chat`. */
export interface ChatTurnRequest {
  sessionId: string
  messages: ChatMessage[]
}

/** Response for `POST /api/chat`. */
export interface ChatTurnResponse {
  assistantMessage: string
}
