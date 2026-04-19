/**
 * Client-side guardrails on the chat history length.
 *
 * The Python backend enforces a hard cap at 30 messages (P2-4 — the
 * endpoint returns 413 "zu lang" above that). We mirror that cap on
 * the client + warn earlier so the user has time to click
 * "In Rezept umwandeln" before the send button goes dead.
 */

/** Plan spec: warn starting at this turn count. */
export const CHAT_WARN_AT = 25

/** Plan spec: hard-block the send button at this turn count. */
export const CHAT_HARD_CAP = 30

export type TurnCapLevel = 'ok' | 'warn' | 'blocked'

/**
 * Classify the current message history against the two thresholds.
 * `turnCount` is the length of `messages[]` **before** the next user
 * turn is appended — callers use this result to decide whether to
 * show the amber banner or disable the send button.
 */
export function classifyTurnCap(turnCount: number): TurnCapLevel {
  if (turnCount >= CHAT_HARD_CAP) return 'blocked'
  if (turnCount >= CHAT_WARN_AT) return 'warn'
  return 'ok'
}
