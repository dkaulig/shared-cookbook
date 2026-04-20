import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '@/features/auth/authStore'
import {
  SseChatStreamError,
  streamChatTurn,
  type SseChatEvent,
  type TurnResult,
} from './sseChatStream'

/**
 * CR4 — sseChatStream consumer tests.
 *
 * We bypass MSW for these tests and stub `globalThis.fetch` directly:
 * the assertions are about how the generator handles ReadableStream
 * chunk boundaries and SSE block parsing, not about any HTTP layer.
 * MSW can drive ReadableStreams but pinning the exact chunk boundary
 * is fiddly; a hand-rolled stream lets us split a `data:` line across
 * two reads to verify the line buffer carries the partial across.
 */

const encoder = new TextEncoder()

interface FetchInit {
  method?: string
  headers?: Record<string, string> | Headers
  body?: string
  signal?: AbortSignal
}

interface FetchCall {
  url: string
  init: FetchInit | undefined
}

const calls: FetchCall[] = []

beforeEach(() => {
  calls.length = 0
  useAuthStore.setState({
    accessToken: 'test-token',
    user: { id: 'u1', email: 'u1@ex.com', displayName: 'U', role: 'User' },
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * Build a `Response` whose body is a ReadableStream emitting the
 * supplied chunks one-by-one, so we can pin the exact boundary the
 * SSE parser sees.
 */
function streamingResponse(
  chunks: Uint8Array[],
  init: { status?: number; signal?: AbortSignal } = {},
): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        if (init.signal?.aborted) {
          controller.error(new DOMException('Aborted', 'AbortError'))
          return
        }
        controller.enqueue(chunk)
      }
      controller.close()
    },
    cancel() {
      /* noop */
    },
  })
  return new Response(stream, {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

function bytes(...lines: string[]): Uint8Array {
  return encoder.encode(lines.join(''))
}

function block(eventName: string, payload: unknown): string {
  return `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`
}

function mockFetchOnce(
  factory: (input: RequestInfo | URL, init?: FetchInit) => Response,
): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init as FetchInit | undefined })
      return factory(input, init as FetchInit | undefined)
    },
  )
}

async function drain<T extends SseChatEvent>(
  gen: AsyncGenerator<T, TurnResult, void>,
): Promise<{ events: T[]; result: TurnResult | undefined; error?: unknown }> {
  const events: T[] = []
  try {
    while (true) {
      const next = await gen.next()
      if (next.done) {
        return { events, result: next.value }
      }
      events.push(next.value)
    }
  } catch (err) {
    return { events, result: undefined, error: err }
  }
}

describe('streamChatTurn — happy path', () => {
  it('parses a single-token reply (message-started → token → usage → done)', async () => {
    const chunks = [
      bytes(
        block('message-started', { messageId: 'msg-1', role: 'assistant' }),
        block('token', { text: 'Hi' }),
        block('usage', {
          promptTokens: 10,
          completionTokens: 1,
          cachedPromptTokens: 0,
        }),
        block('done', { messageId: 'msg-1' }),
      ),
    ]
    mockFetchOnce(() => streamingResponse(chunks))

    const ctrl = new AbortController()
    const { events, result } = await drain(
      streamChatTurn('s-1', 'Hallo', ctrl.signal),
    )

    expect(events.map((e) => e.type)).toEqual([
      'message-started',
      'token',
      'usage',
      'done',
    ])
    expect(result).toEqual({
      assistantMessageId: 'msg-1',
      fullContent: 'Hi',
      usage: { promptTokens: 10, completionTokens: 1, cachedPromptTokens: 0 },
    })
    expect(calls[0]!.url).toBe('/api/chat/sessions/s-1/turn')
    expect(calls[0]!.init?.method).toBe('POST')
    expect(calls[0]!.init?.body).toBe(JSON.stringify({ content: 'Hallo' }))
  })

  it('concatenates multi-token replies in order', async () => {
    const chunks = [
      bytes(
        block('message-started', { messageId: 'msg-2', role: 'assistant' }),
        block('token', { text: 'Hallo ' }),
        block('token', { text: 'Welt' }),
        block('token', { text: '! Wie' }),
        block('token', { text: ' geht' }),
        block('token', { text: ' es?' }),
        block('done', { messageId: 'msg-2' }),
      ),
    ]
    mockFetchOnce(() => streamingResponse(chunks))

    const { events, result } = await drain(
      streamChatTurn('s', 'q', new AbortController().signal),
    )
    expect(result?.fullContent).toBe('Hallo Welt! Wie geht es?')
    const tokenEvents = events.filter((e) => e.type === 'token')
    expect(tokenEvents).toHaveLength(5)
  })

  it('yields heartbeat events but the consumer can ignore them — content is unaffected', async () => {
    const chunks = [
      bytes(
        block('message-started', { messageId: 'msg-3', role: 'assistant' }),
        block('token', { text: 'Eins' }),
        'event: heartbeat\ndata: {}\n\n',
        block('token', { text: ' zwei' }),
        block('done', { messageId: 'msg-3' }),
      ),
    ]
    mockFetchOnce(() => streamingResponse(chunks))

    const { events, result } = await drain(
      streamChatTurn('s', 'q', new AbortController().signal),
    )
    expect(events.some((e) => e.type === 'heartbeat')).toBe(true)
    expect(result?.fullContent).toBe('Eins zwei')
  })
})

describe('streamChatTurn — error paths', () => {
  it('throws SseChatStreamError when the stream emits an error event mid-flight', async () => {
    const chunks = [
      bytes(
        block('message-started', { messageId: 'msg-4', role: 'assistant' }),
        block('token', { text: 'Anfang' }),
        block('error', {
          code: 'azure_unavailable',
          message: 'KI-Dienst offline.',
        }),
      ),
    ]
    mockFetchOnce(() => streamingResponse(chunks))

    const { events, error } = await drain(
      streamChatTurn('s', 'q', new AbortController().signal),
    )
    expect(error).toBeInstanceOf(SseChatStreamError)
    expect((error as SseChatStreamError).code).toBe('azure_unavailable')
    expect((error as SseChatStreamError).message).toMatch(/offline/i)
    // The error event was yielded before the throw so the UI can paint
    // the partial content's "interrupted" state.
    expect(events.map((e) => e.type)).toContain('error')
  })

  it('throws when the response is non-OK before the stream begins', async () => {
    mockFetchOnce(
      () =>
        new Response(
          JSON.stringify({ code: 'rate_limited', message: 'Zu viele Anfragen.' }),
          { status: 429, headers: { 'Content-Type': 'application/json' } },
        ),
    )
    const { error } = await drain(
      streamChatTurn('s', 'q', new AbortController().signal),
    )
    expect(error).toBeInstanceOf(SseChatStreamError)
    expect((error as SseChatStreamError).code).toBe('rate_limited')
  })

  it('throws when the stream closes without a done event', async () => {
    const chunks = [
      bytes(
        block('message-started', { messageId: 'msg-5', role: 'assistant' }),
        block('token', { text: 'Halb' }),
      ),
    ]
    mockFetchOnce(() => streamingResponse(chunks))

    const { error } = await drain(
      streamChatTurn('s', 'q', new AbortController().signal),
    )
    expect(error).toBeInstanceOf(SseChatStreamError)
    expect((error as SseChatStreamError).code).toBe('stream_truncated')
  })
})

describe('streamChatTurn — abort behaviour', () => {
  it('the AbortSignal cancels the underlying read and the generator rejects', async () => {
    const ctrl = new AbortController()
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller
        controller.enqueue(
          bytes(
            block('message-started', { messageId: 'msg-6', role: 'assistant' }),
            block('token', { text: 'Tick' }),
          ),
        )
        // Stream stays open — abort tears it down.
      },
      cancel() {
        // Reader-side cancel from streamChatTurn — we close cleanly
        // here so the test doesn't leak an unhandled rejection from
        // a still-open controller.
        try {
          controllerRef?.close()
        } catch {
          /* ignore */
        }
      },
    })
    const response = new Response(stream, { status: 200 })
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const sig = init?.signal
        if (sig?.aborted) throw new DOMException('Aborted', 'AbortError')
        return response
      },
    )

    const gen = streamChatTurn('s', 'q', ctrl.signal)
    const first = await gen.next()
    expect(first.done).toBe(false)
    expect(first.value.type).toBe('message-started')
    const second = await gen.next()
    expect(second.value.type).toBe('token')

    // Abort while a read is in flight; the generator rejects with
    // AbortError once the cancel propagates.
    setTimeout(() => ctrl.abort(), 0)
    await expect(gen.next()).rejects.toBeDefined()
  })
})

describe('streamChatTurn — chunk boundary handling', () => {
  it('parses correctly when a single SSE block is split across two ReadableStream reads', async () => {
    // Slice the reply at an awkward boundary INSIDE a `data:` line so
    // the line buffer has to carry the partial across.
    const fullText =
      block('message-started', { messageId: 'msg-7', role: 'assistant' }) +
      block('token', { text: 'GeteiltesToken' }) +
      block('done', { messageId: 'msg-7' })
    const splitAt = fullText.indexOf('GeteiltesToken') + 5 // mid-string
    const a = bytes(fullText.slice(0, splitAt))
    const b = bytes(fullText.slice(splitAt))
    mockFetchOnce(() => streamingResponse([a, b]))

    const { result } = await drain(
      streamChatTurn('s', 'q', new AbortController().signal),
    )
    expect(result?.fullContent).toBe('GeteiltesToken')
  })

  it('parses correctly when the SSE block delimiter \\n\\n itself is split across reads', async () => {
    const full =
      block('message-started', { messageId: 'msg-8', role: 'assistant' }) +
      block('token', { text: 'X' }) +
      block('done', { messageId: 'msg-8' })
    // Split exactly between the two `\n` of one of the block delimiters
    // so the parser sees `…\n` then `\nevent:…` on subsequent reads.
    const idx = full.indexOf('\n\n') + 1
    const a = bytes(full.slice(0, idx))
    const b = bytes(full.slice(idx))
    mockFetchOnce(() => streamingResponse([a, b]))

    const { result } = await drain(
      streamChatTurn('s', 'q', new AbortController().signal),
    )
    expect(result?.fullContent).toBe('X')
  })

  it('URL-encodes the sessionId so special characters do not break the path', async () => {
    mockFetchOnce(() =>
      streamingResponse([
        bytes(
          block('message-started', { messageId: 'm', role: 'assistant' }),
          block('token', { text: 'ok' }),
          block('done', { messageId: 'm' }),
        ),
      ]),
    )
    await drain(
      streamChatTurn('weird/id?x=1', 'q', new AbortController().signal),
    )
    expect(calls[0]!.url).toContain(encodeURIComponent('weird/id?x=1'))
  })

  it('attaches the bearer token from the auth store to the Authorization header', async () => {
    mockFetchOnce(() =>
      streamingResponse([
        bytes(
          block('message-started', { messageId: 'm', role: 'assistant' }),
          block('token', { text: 'k' }),
          block('done', { messageId: 'm' }),
        ),
      ]),
    )
    await drain(
      streamChatTurn('s', 'q', new AbortController().signal),
    )
    const headers = calls[0]!.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer test-token')
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers.Accept).toBe('text/event-stream')
  })
})
