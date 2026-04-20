import type {
  SseDoneData,
  SseErrorData,
  SseMessageStartedData,
  SseTokenData,
  SseUsageData,
} from '@familien-kochbuch/shared'
import { useAuthStore } from '@/features/auth/authStore'

/**
 * CR4 — SSE consumer for `POST /api/chat/sessions/:id/turn`.
 *
 * Pure async-generator. Yields each parsed SSE event as it arrives;
 * resolves with the final {@link TurnResult} on the `done` event.
 *
 * Why a generator (and not a callback bag like hoppr's mobile client)
 * — the React caller can `for-await-of` and apply state mutations
 * inline, which keeps the streaming-into-bubble logic in ChatPage
 * readable and stays out of the way of cancellation: an `AbortError`
 * during `reader.read()` propagates as a normal generator rejection
 * the caller catches once.
 *
 * The 6 event names (`message-started`, `token`, `usage`, `done`,
 * `heartbeat`, `error`) match CR2's server-side schema exactly. The
 * generator never retries — the caller owns retry UX.
 *
 * Parsing is line-buffer-driven so a `data:` block split across
 * multiple `ReadableStream` chunks still parses correctly: we
 * accumulate into `buffer`, split on the SSE block delimiter
 * (`\n\n`), and only consume complete blocks; the trailing partial
 * remains in `buffer` for the next read.
 */

export type SseChatEventType =
  | 'message-started'
  | 'token'
  | 'usage'
  | 'done'
  | 'heartbeat'
  | 'error'

export interface SseChatEvent {
  type: SseChatEventType
  data: unknown
}

export interface TurnResult {
  assistantMessageId: string
  fullContent: string
  usage?: {
    promptTokens: number
    completionTokens: number
    cachedPromptTokens: number
  }
}

/**
 * Error thrown when the server-emitted `event: error` block is
 * received. Carries the SSE error code for callers that want to
 * differentiate retry copy.
 */
export class SseChatStreamError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'SseChatStreamError'
    this.code = code
  }
}

const SSE_BLOCK_DELIMITER = '\n\n'

/**
 * Stream a single chat turn. The caller iterates with `for-await-of`,
 * applies state mutations per event, and reads the final
 * {@link TurnResult} from the generator's return value.
 *
 * @param sessionId  The session id (URL-encoded by the caller? — no:
 *                   we encode here so callers can pass raw ids).
 * @param content    The user-typed message body.
 * @param signal     AbortSignal — when aborted, the underlying
 *                   `ReadableStreamDefaultReader` cancel propagates
 *                   and the generator throws an `AbortError`.
 */
export async function* streamChatTurn(
  sessionId: string,
  content: string,
  signal: AbortSignal,
): AsyncGenerator<SseChatEvent, TurnResult, void> {
  const encoded = encodeURIComponent(sessionId)
  const { accessToken } = useAuthStore.getState()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  }
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`

  const response = await fetch(`/api/chat/sessions/${encoded}/turn`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ content }),
    signal,
    credentials: 'include',
  })

  if (!response.ok) {
    let code = `http_${response.status}`
    let message = response.statusText || 'Stream konnte nicht geöffnet werden.'
    try {
      const payload = (await response.json()) as { code?: string; message?: string }
      if (payload?.code) code = payload.code
      if (payload?.message) message = payload.message
    } catch {
      /* non-JSON body — keep the http_<status> default. */
    }
    throw new SseChatStreamError(code, message)
  }

  const body = response.body
  if (!body) {
    throw new SseChatStreamError(
      'no_stream',
      'Antwort enthielt keinen Stream-Body.',
    )
  }

  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let result: TurnResult | null = null

  // Track the partial assistant content + message id locally so
  // `done` can resolve into a `TurnResult` even if the server
  // doesn't echo `messageId` on `done` (defensive — CR2 always does).
  let assistantMessageId = ''
  let fullContent = ''
  let usage: TurnResult['usage'] | undefined

  // Belt-and-braces abort propagation: if the caller aborts, also
  // explicitly cancel the underlying reader so an in-flight read()
  // rejects promptly. fetch's own signal handling already does this
  // for real network transports, but mocked transports (MSW + the
  // hand-rolled streams in tests) sometimes leave the read pending.
  const onAbort = () => {
    try {
      void reader.cancel(new DOMException('Aborted', 'AbortError'))
    } catch {
      /* already cancelled — ignore. */
    }
  }
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let blockEnd = buffer.indexOf(SSE_BLOCK_DELIMITER)
      while (blockEnd !== -1) {
        const block = buffer.slice(0, blockEnd)
        buffer = buffer.slice(blockEnd + SSE_BLOCK_DELIMITER.length)
        blockEnd = buffer.indexOf(SSE_BLOCK_DELIMITER)

        const parsed = parseSseBlock(block)
        if (!parsed) continue

        // Track stream state from the events we care about.
        switch (parsed.type) {
          case 'message-started': {
            const d = parsed.data as Partial<SseMessageStartedData>
            if (typeof d.messageId === 'string') assistantMessageId = d.messageId
            break
          }
          case 'token': {
            const d = parsed.data as Partial<SseTokenData>
            if (typeof d.text === 'string') fullContent += d.text
            break
          }
          case 'usage': {
            const d = parsed.data as Partial<SseUsageData>
            if (
              typeof d.promptTokens === 'number' &&
              typeof d.completionTokens === 'number' &&
              typeof d.cachedPromptTokens === 'number'
            ) {
              usage = {
                promptTokens: d.promptTokens,
                completionTokens: d.completionTokens,
                cachedPromptTokens: d.cachedPromptTokens,
              }
            }
            break
          }
          case 'done': {
            const d = parsed.data as Partial<SseDoneData>
            if (typeof d.messageId === 'string') assistantMessageId = d.messageId
            result = { assistantMessageId, fullContent, usage }
            break
          }
          case 'error': {
            const d = parsed.data as Partial<SseErrorData>
            const code = typeof d.code === 'string' ? d.code : 'stream_error'
            const message =
              typeof d.message === 'string'
                ? d.message
                : 'Stream-Fehler vom Server.'
            yield parsed
            throw new SseChatStreamError(code, message)
          }
        }

        yield parsed

        if (result) return result
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
    try {
      reader.releaseLock()
    } catch {
      /* lock may have been released by an upstream cancel — ignore. */
    }
  }

  // Reached end-of-stream without a `done` event. If the caller
  // aborted, surface that as a DOMException(AbortError) so callers
  // can branch on it the same way they would for a real
  // network-level abort. Otherwise the connection was cut mid-
  // flight from the server side without an explicit error block.
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }
  throw new SseChatStreamError(
    'stream_truncated',
    'Verbindung wurde unterbrochen, bevor die Antwort vollständig war.',
  )
}

/**
 * Parse a single SSE block (already delimited; lacks the trailing
 * `\n\n`). Returns null for blocks that don't carry both an `event:`
 * and a `data:` line — we ignore comments + malformed payloads
 * silently rather than throwing, matching the SSE spec's
 * "best-effort consumer" guidance.
 */
function parseSseBlock(block: string): SseChatEvent | null {
  let event: string | null = null
  let dataRaw = ''
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim()
    } else if (line.startsWith('data:')) {
      // Per spec: multiple `data:` lines concatenate with `\n` between them.
      const piece = line.slice('data:'.length).trim()
      dataRaw = dataRaw.length === 0 ? piece : `${dataRaw}\n${piece}`
    }
    // Lines starting with `:` (comments) and unknown fields fall through.
  }

  if (!event) return null
  if (!isKnownEventType(event)) return null

  let data: unknown
  if (dataRaw.length === 0) {
    data = null
  } else {
    try {
      data = JSON.parse(dataRaw)
    } catch {
      // Malformed JSON — skip the block.
      return null
    }
  }
  return { type: event, data }
}

const KNOWN_EVENTS: ReadonlySet<string> = new Set<string>([
  'message-started',
  'token',
  'usage',
  'done',
  'heartbeat',
  'error',
])

function isKnownEventType(name: string): name is SseChatEventType {
  return KNOWN_EVENTS.has(name)
}
