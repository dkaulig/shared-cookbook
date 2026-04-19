import type { ExtractionResult } from '@familien-kochbuch/shared'

/**
 * Session-scoped stash for the chat → recipe handoff.
 *
 * The chat doesn't go through the Hangfire import pipeline — there's no
 * `RecipeImport` row on the server the frontend can poll later. Instead
 * the chat-to-recipe structuring call returns the `ExtractionResult`
 * synchronously; we stash it in sessionStorage under a transient client
 * id and hand that id to `RecipeFormPage` via `?chatImportId=<uuid>`.
 *
 * Why sessionStorage (not localStorage): chat dialogues can contain
 * medical + dietary info (explicit privacy call-out in the P2-9 plan
 * + PRD §5.4). sessionStorage auto-clears when the tab closes, and is
 * scoped per-tab — so even a shared device won't leak the dialogue
 * between subsequent sessions.
 *
 * The memo is cleared:
 *   - After a successful save in `RecipeFormPage` (the recipe now lives
 *     in the DB, no reason to keep the cached extraction around).
 *   - On explicit "verwerfen" / cancel from the recipe form.
 *   - Automatically when the tab closes (sessionStorage semantics).
 */
const STORAGE_PREFIX = 'fk.chatImport.'

function key(chatImportId: string): string {
  return `${STORAGE_PREFIX}${chatImportId}`
}

function storageOrNull(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

export interface StashedChatImport {
  groupId: string
  result: ExtractionResult
}

export function stashChatImport(
  chatImportId: string,
  payload: StashedChatImport,
): void {
  const s = storageOrNull()
  if (!s) return
  try {
    s.setItem(key(chatImportId), JSON.stringify(payload))
  } catch {
    /* quota exceeded — silent no-op. */
  }
}

export function recallChatImport(
  chatImportId: string,
): StashedChatImport | null {
  const s = storageOrNull()
  if (!s) return null
  try {
    const raw = s.getItem(key(chatImportId))
    if (!raw) return null
    return JSON.parse(raw) as StashedChatImport
  } catch {
    // Malformed JSON in sessionStorage is a client bug — don't wedge
    // the form on the way in. Fall through to blank-create.
    return null
  }
}

export function forgetChatImport(chatImportId: string): void {
  const s = storageOrNull()
  if (!s) return
  try {
    s.removeItem(key(chatImportId))
  } catch {
    /* ignore */
  }
}
