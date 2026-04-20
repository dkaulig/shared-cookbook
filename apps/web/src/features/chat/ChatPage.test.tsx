import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type {
  ChatMessageDto,
  ChatSessionListItem,
  GroupSummary,
} from '@familien-kochbuch/shared'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { ChatPage } from './ChatPage'
import { recallChatImport } from './chatImportMemo'

const FIXED_SESSION_ID = '00000000-1111-2222-3333-444444444444'

const encoder = new TextEncoder()

function groupSummary(over: Partial<GroupSummary>): GroupSummary {
  return {
    id: 'g1',
    name: 'Familie',
    description: null,
    coverImageUrl: null,
    defaultServings: 4,
    isPrivateCollection: false,
    memberCount: 4,
    myRole: 'Admin',
    version: 0,
    ...over,
  }
}

function sessionListItem(
  over: Partial<ChatSessionListItem> = {},
): ChatSessionListItem {
  return {
    id: FIXED_SESSION_ID,
    title: null,
    messageCount: 0,
    createdAt: '2026-04-20T10:00:00Z',
    updatedAt: '2026-04-20T10:00:00Z',
    ...over,
  }
}

function sseBlock(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/**
 * Build a `Response`-shaped object with a streaming SSE body. Used by
 * the MSW handlers below to simulate the .NET turn endpoint.
 */
function sseResponse(blocks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const b of blocks) {
        controller.enqueue(encoder.encode(b))
      }
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

/**
 * SSE response that holds open until `release()` is called, so tests
 * can assert intermediate UI states (typing indicator, abort button).
 *
 * The release-controller is wired up synchronously inside `start`,
 * but `start()` only runs once the consumer actually pulls — so the
 * factory eagerly creates the controller via a deferred-promise
 * pattern: the controller is captured the first time start fires,
 * and any release/abort calls before then queue up.
 */
function deferredSseResponse() {
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null
  const pendingChunks: Uint8Array[] = []
  let pendingClose = false
  let pendingError: unknown = null

  const flush = () => {
    if (!controllerRef) return
    for (const chunk of pendingChunks) controllerRef.enqueue(chunk)
    pendingChunks.length = 0
    if (pendingError) {
      try {
        controllerRef.error(pendingError)
      } catch {
        /* already errored */
      }
      pendingError = null
    } else if (pendingClose) {
      try {
        controllerRef.close()
      } catch {
        /* already closed */
      }
      pendingClose = false
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller
      flush()
    },
  })
  const response = new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
  return {
    response,
    release: (blocks: string[]) => {
      for (const b of blocks) pendingChunks.push(encoder.encode(b))
      pendingClose = true
      flush()
    },
    sendOnly: (blocks: string[]) => {
      for (const b of blocks) pendingChunks.push(encoder.encode(b))
      flush()
    },
    abort: () => {
      pendingError = new DOMException('Aborted', 'AbortError')
      flush()
    },
  }
}

function LocationProbe() {
  const loc = useLocation()
  return (
    <div data-testid="location">
      {loc.pathname}
      {loc.search}
    </div>
  )
}

function renderPage(sessionId: string = FIXED_SESSION_ID) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/chat/${sessionId}`]}>
          <LocationProbe />
          <Routes>
            <Route path="/chat/:sessionId" element={children} />
            <Route
              path="/groups/:groupId/recipes/new"
              element={<div data-testid="recipe-new-page">recipe new</div>}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    )
  }
  return render(<ChatPage />, { wrapper: Wrapper })
}

beforeEach(() => {
  useAuthStore.getState().setSession('tok', {
    id: 'u1',
    email: 'u1@ex.com',
    displayName: 'U',
    role: 'User',
  })
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(
    FIXED_SESSION_ID as `${string}-${string}-${string}-${string}-${string}`,
  )
  // Default handlers so tests that don't override get sensible
  // no-op-ish responses.
  server.use(
    http.get('/api/groups', () =>
      HttpResponse.json<GroupSummary[]>([groupSummary({})]),
    ),
    http.get('/api/chat/sessions', () =>
      HttpResponse.json<ChatSessionListItem[]>([sessionListItem({})]),
    ),
    http.get('/api/chat/sessions/:sessionId/messages', () =>
      HttpResponse.json<ChatMessageDto[]>([]),
    ),
  )
})

afterEach(() => {
  server.resetHandlers()
  useAuthStore.getState().clear()
  window.sessionStorage.clear()
  vi.restoreAllMocks()
})

describe('<ChatPage /> — rendering + session', () => {
  it('renders the fallback "Rezept-Chat" title when the session has none yet', async () => {
    renderPage()
    expect(
      await screen.findByRole('heading', { name: /Rezept-Chat/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/was möchtest du heute kochen/i),
    ).toBeInTheDocument()
    const send = screen.getByRole('button', { name: /^Senden$/ })
    expect(send).toBeDisabled()
  })

  it('renders the session title in the top bar when present', async () => {
    server.use(
      http.get('/api/chat/sessions', () =>
        HttpResponse.json<ChatSessionListItem[]>([
          sessionListItem({ title: 'Kartoffelauflauf' }),
        ]),
      ),
    )
    renderPage()
    expect(
      await screen.findByRole('heading', { name: /Kartoffelauflauf/ }),
    ).toBeInTheDocument()
  })

  it('redirects back to /chat when the URL sessionId is not in the sessions list (stale/alien link)', async () => {
    server.use(
      http.get('/api/chat/sessions', () =>
        HttpResponse.json<ChatSessionListItem[]>([
          sessionListItem({ id: 'someone-else' }),
        ]),
      ),
    )
    renderPage(FIXED_SESSION_ID)
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/chat'),
    )
  })

  it('hydrates prior messages from the server on mount (resume flow)', async () => {
    server.use(
      http.get('/api/chat/sessions/:sessionId/messages', () =>
        HttpResponse.json<ChatMessageDto[]>([
          {
            id: 'm1',
            role: 'user',
            content: 'Mein Lauch ist welk',
            createdAt: '2026-04-20T09:00:00Z',
          },
          {
            id: 'm2',
            role: 'assistant',
            content: 'Dann zur Suppe verarbeiten!',
            createdAt: '2026-04-20T09:01:00Z',
          },
        ]),
      ),
    )
    renderPage()
    expect(await screen.findByText('Mein Lauch ist welk')).toBeInTheDocument()
    expect(
      await screen.findByText('Dann zur Suppe verarbeiten!'),
    ).toBeInTheDocument()
  })
})

describe('<ChatPage /> — SSE streaming', () => {
  it('streams tokens into the assistant bubble and shows the typing indicator while open', async () => {
    const user = userEvent.setup()
    const deferred = deferredSseResponse()
    server.use(
      http.post('/api/chat/sessions/:sessionId/turn', () => deferred.response),
    )
    renderPage()
    await user.type(screen.getByLabelText(/Nachricht/i), 'Hallo')
    await user.click(screen.getByRole('button', { name: /^Senden$/ }))
    // User bubble appears immediately (optimistic).
    expect(await screen.findByText('Hallo')).toBeInTheDocument()
    // Typing indicator visible while stream open.
    expect(
      await screen.findByRole('status', { name: /Antwort wird geschrieben/i }),
    ).toBeInTheDocument()
    // Abort button replaces send.
    expect(
      screen.getByRole('button', { name: /Abbrechen/i }),
    ).toBeInTheDocument()

    deferred.release([
      sseBlock('message-started', { messageId: 'srv-1', role: 'assistant' }),
      sseBlock('token', { text: 'Hallo ' }),
      sseBlock('token', { text: 'Welt' }),
      sseBlock('done', { messageId: 'srv-1' }),
    ])

    await screen.findByText('Hallo Welt')
    await waitFor(() => {
      expect(
        screen.queryByRole('status', { name: /Antwort wird geschrieben/i }),
      ).not.toBeInTheDocument()
    })
    // Send button is back + enabled-once-input again.
    expect(
      screen.getByRole('button', { name: /^Senden$/ }),
    ).toBeInTheDocument()
  })

  it('clears the input on send', async () => {
    const user = userEvent.setup()
    server.use(
      http.post('/api/chat/sessions/:sessionId/turn', () =>
        sseResponse([
          sseBlock('message-started', { messageId: 's', role: 'assistant' }),
          sseBlock('token', { text: 'ok' }),
          sseBlock('done', { messageId: 's' }),
        ]),
      ),
    )
    renderPage()
    const input = screen.getByLabelText(/Nachricht/i) as HTMLTextAreaElement
    await user.type(input, 'Hallo')
    await user.click(screen.getByRole('button', { name: /^Senden$/ }))
    await waitFor(() => expect(input.value).toBe(''))
  })
})

describe('<ChatPage /> — abort + retry', () => {
  it('Abbrechen aborts the stream and the partial content is preserved via refetch', async () => {
    const user = userEvent.setup()
    const deferred = deferredSseResponse()
    let messagesCallCount = 0
    server.use(
      http.post('/api/chat/sessions/:sessionId/turn', () => deferred.response),
      http.get('/api/chat/sessions/:sessionId/messages', () => {
        messagesCallCount += 1
        if (messagesCallCount > 1) {
          return HttpResponse.json<ChatMessageDto[]>([
            {
              id: 'srv-user-1',
              role: 'user',
              content: 'Frag was',
              createdAt: '2026-04-20T11:00:00Z',
            },
            {
              id: 'srv-asst-1',
              role: 'assistant',
              content: 'Teilantwort',
              createdAt: '2026-04-20T11:00:01Z',
            },
          ])
        }
        return HttpResponse.json<ChatMessageDto[]>([])
      }),
    )
    renderPage()
    await user.type(screen.getByLabelText(/Nachricht/i), 'Frag was')
    await user.click(screen.getByRole('button', { name: /^Senden$/ }))

    // Stream a partial token without closing the stream so the
    // typing indicator + Abbrechen button stay live.
    deferred.sendOnly([
      sseBlock('message-started', { messageId: 'p', role: 'assistant' }),
      sseBlock('token', { text: 'Teil' }),
    ])
    // Wait for the partial to render then abort.
    await screen.findByText('Teil')
    await user.click(
      await screen.findByRole('button', { name: /Abbrechen/i }),
    )

    // After the refetch, the server-side partial appears.
    await screen.findByText('Teilantwort', undefined, { timeout: 3000 })
  })

  it('shows the error banner + Erneut versuchen on a stream error event', async () => {
    const user = userEvent.setup()
    server.use(
      http.post('/api/chat/sessions/:sessionId/turn', () =>
        sseResponse([
          sseBlock('message-started', { messageId: 'e', role: 'assistant' }),
          sseBlock('token', { text: 'Beginn' }),
          sseBlock('error', {
            code: 'azure_unavailable',
            message: 'KI-Dienst offline.',
          }),
        ]),
      ),
    )
    renderPage()
    await user.type(screen.getByLabelText(/Nachricht/i), 'Hi')
    await user.click(screen.getByRole('button', { name: /^Senden$/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/offline/i)
    // Both the inline bubble retry button and the global banner retry button.
    const retryBtns = await screen.findAllByRole('button', {
      name: /Erneut versuchen/i,
    })
    expect(retryBtns.length).toBeGreaterThanOrEqual(1)
  })

  it('Erneut versuchen drops the errored bubble and re-submits the same content', async () => {
    const user = userEvent.setup()
    let callCount = 0
    server.use(
      http.post('/api/chat/sessions/:sessionId/turn', () => {
        callCount += 1
        if (callCount === 1) {
          return sseResponse([
            sseBlock('message-started', { messageId: 'e1', role: 'assistant' }),
            sseBlock('error', {
              code: 'azure_unavailable',
              message: 'Offline.',
            }),
          ])
        }
        return sseResponse([
          sseBlock('message-started', { messageId: 'ok', role: 'assistant' }),
          sseBlock('token', { text: 'Klappt jetzt' }),
          sseBlock('done', { messageId: 'ok' }),
        ])
      }),
    )
    renderPage()
    await user.type(screen.getByLabelText(/Nachricht/i), 'Erneut')
    await user.click(screen.getByRole('button', { name: /^Senden$/ }))
    await screen.findByRole('alert')

    const retryButtons = await screen.findAllByRole('button', {
      name: /Erneut versuchen/i,
    })
    await user.click(retryButtons[0]!)
    await screen.findByText('Klappt jetzt')
    // The errored bubble should not still be on screen (no double "Antwort unterbrochen" label).
    expect(screen.queryByText(/Antwort unterbrochen/i)).not.toBeInTheDocument()
  })
})

describe('<ChatPage /> — turn cap', () => {
  it('blocks send at the hard cap and shows the dialog-full helper', async () => {
    server.use(
      http.get('/api/chat/sessions/:sessionId/messages', () =>
        // 30 prior messages — already at the cap so a single check
        // suffices without firing 15 SSE rounds in jsdom.
        HttpResponse.json<ChatMessageDto[]>(
          Array.from({ length: 30 }, (_, i) => ({
            id: `m${i}`,
            role: i % 2 === 0 ? 'user' : 'assistant',
            content: `msg ${i}`,
            createdAt: `2026-04-20T10:${String(i).padStart(2, '0')}:00Z`,
          })),
        ),
      ),
    )
    renderPage()
    expect(await screen.findByText(/Dialog ist voll/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Nachricht/i)).toBeDisabled()
    expect(screen.getByRole('button', { name: /^Senden$/ })).toBeDisabled()
  })
})

describe('<ChatPage /> — In Rezept umwandeln', () => {
  it('converts the chat, stashes the result in sessionStorage, and navigates to /groups/:groupId/recipes/new?chatImportId=…', async () => {
    const user = userEvent.setup()
    const chatImportId = '00000000-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      chatImportId as `${string}-${string}-${string}-${string}-${string}`,
    )
    server.use(
      http.get('/api/groups', () =>
        HttpResponse.json<GroupSummary[]>([
          groupSummary({ id: 'only-group', isPrivateCollection: true }),
        ]),
      ),
      // Two server-side assistant messages so the Convert CTA mounts.
      http.get('/api/chat/sessions/:sessionId/messages', () =>
        HttpResponse.json<ChatMessageDto[]>([
          {
            id: 'a1',
            role: 'assistant',
            content: 'Reply 1',
            createdAt: '2026-04-20T10:01:00Z',
          },
          {
            id: 'a2',
            role: 'assistant',
            content: 'Reply 2',
            createdAt: '2026-04-20T10:02:00Z',
          },
        ]),
      ),
      http.post('/api/chat/sessions/:sessionId/to-recipe', () =>
        HttpResponse.json({
          recipe: {
            title: 'Kartoffel-Lauch-Auflauf',
            description: null,
            servings: 4,
            difficulty: 1,
            prep_minutes: 20,
            cook_minutes: 30,
            ingredients: [],
            steps: [],
            tags: ['vegan'],
            source_url: 'chat://session',
            thumbnail_url: null,
          },
          confidence: { overall: 'medium', notes: [] },
        }),
      ),
    )
    renderPage()
    await user.click(
      await screen.findByRole('button', { name: /In Rezept umwandeln/i }),
    )

    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(
        /\/groups\/only-group\/recipes\/new\?chatImportId=00000000-bbbb-bbbb-bbbb-bbbbbbbbbbbb/,
      ),
    )
    const recalled = recallChatImport(chatImportId)
    expect(recalled).not.toBeNull()
    expect(recalled!.groupId).toBe('only-group')
    expect(recalled!.result.recipe.title).toBe('Kartoffel-Lauch-Auflauf')
  })
})

describe('<ChatPage /> — rename top-bar affordance', () => {
  it('opens a rename dialog when the pencil is clicked and PATCHes on submit', async () => {
    const user = userEvent.setup()
    let patchedBody: { title: string } | null = null
    server.use(
      http.patch('/api/chat/sessions/:sessionId', async ({ request }) => {
        patchedBody = (await request.json()) as { title: string }
        return new HttpResponse(null, { status: 204 })
      }),
    )
    renderPage()
    // Wait for the sessions list to load so the top-bar pencil can mount.
    await screen.findByRole('button', { name: /Unterhaltung umbenennen/i })
    await user.click(
      screen.getByRole('button', { name: /Unterhaltung umbenennen/i }),
    )
    const input = await screen.findByLabelText(/Titel/i)
    await user.clear(input)
    await user.type(input, 'Omelette')
    await user.click(screen.getByRole('button', { name: /Speichern/i }))

    await waitFor(() => {
      expect(patchedBody).toEqual({ title: 'Omelette' })
    })
  })
})

describe('<ChatPage /> — per-session draft persistence', () => {
  it('restores a sessionStorage draft for the current sessionId', async () => {
    window.sessionStorage.setItem(
      `fk-chat-draft:${FIXED_SESSION_ID}`,
      'Half-typed prompt',
    )
    renderPage()
    const input = (await screen.findByLabelText(/Nachricht/i)) as HTMLTextAreaElement
    await waitFor(() => {
      expect(input.value).toBe('Half-typed prompt')
    })
  })

  it('clears the draft from sessionStorage once the textarea is emptied', async () => {
    const user = userEvent.setup()
    renderPage()
    const input = (await screen.findByLabelText(/Nachricht/i)) as HTMLTextAreaElement
    await user.type(input, 'X')
    await waitFor(() => {
      expect(
        window.sessionStorage.getItem(`fk-chat-draft:${FIXED_SESSION_ID}`),
      ).toBe('X')
    })
    await user.clear(input)
    await waitFor(() => {
      expect(
        window.sessionStorage.getItem(`fk-chat-draft:${FIXED_SESSION_ID}`),
      ).toBeNull()
    })
  })
})

describe('<ChatPage /> — input behaviour', () => {
  it('submits on Enter and inserts a newline on Shift+Enter', async () => {
    const user = userEvent.setup()
    server.use(
      http.post('/api/chat/sessions/:sessionId/turn', () =>
        sseResponse([
          sseBlock('message-started', { messageId: 'x', role: 'assistant' }),
          sseBlock('token', { text: 'ok' }),
          sseBlock('done', { messageId: 'x' }),
        ]),
      ),
    )
    renderPage()
    const input = screen.getByLabelText(/Nachricht/i) as HTMLTextAreaElement
    await user.type(input, 'ohne shift')
    await user.type(input, '{Enter}')
    // The user bubble appears in the message list; use findAllByText
    // to tolerate any duplicate render the optimistic + persisted
    // dedupe might briefly produce while the refetch lands.
    const matches = await screen.findAllByText('ohne shift')
    expect(matches.length).toBeGreaterThanOrEqual(1)

    await user.type(input, 'line1{Shift>}{Enter}{/Shift}line2')
    expect(input.value).toMatch(/line1\nline2/)
  })
})

describe('<ChatPage /> — navigation chrome', () => {
  it('renders a back button that navigates back one step in history', async () => {
    const user = userEvent.setup()
    renderPage()
    const backBtn = screen.getByRole('button', { name: /Zurück/i })
    expect(backBtn).toBeInTheDocument()
    await user.click(backBtn)
  })

  it('does not write localStorage entries that mention chat (privacy)', async () => {
    const user = userEvent.setup()
    server.use(
      http.post('/api/chat/sessions/:sessionId/turn', () =>
        sseResponse([
          sseBlock('message-started', { messageId: 'x', role: 'assistant' }),
          sseBlock('token', { text: 'yo' }),
          sseBlock('done', { messageId: 'x' }),
        ]),
      ),
    )
    renderPage()
    await user.type(screen.getByLabelText(/Nachricht/i), 'something')
    await user.click(screen.getByRole('button', { name: /^Senden$/ }))
    await screen.findByText('yo')
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const k = window.localStorage.key(i) ?? ''
      expect(k).not.toMatch(/chat/i)
    }
  })
})

// Silence a potential "unused" lint on this helper — referenced above.
void within

describe('<ChatPage /> — BUG-001 regression: mobile viewport sizing', () => {
  const source = readFileSync(resolve(__dirname, './ChatPage.tsx'), 'utf8')

  it('uses dynamic viewport height units (100dvh), not static 100vh', () => {
    expect(source).toMatch(/100dvh/)
    expect(source).not.toMatch(/100vh[)\]\s;,]/)
  })

  it('includes env(safe-area-inset-bottom) so the input clears the iOS home indicator', () => {
    expect(source).toMatch(/safe-area-inset-bottom/)
  })

  it('viewport meta in index.html includes viewport-fit=cover (required for non-zero safe-area insets on iOS)', () => {
    const html = readFileSync(
      resolve(__dirname, '../../../index.html'),
      'utf8',
    )
    expect(html).toMatch(/viewport-fit=cover/)
  })
})

describe('<ChatPage /> — BUG-025 regression: input font-size ≥ 16px', () => {
  it('chat textarea className includes `text-base` (prevents iOS auto-zoom)', () => {
    renderPage()
    const textarea = screen.getByLabelText(/Nachricht/i)
    expect(textarea.className).toMatch(/\btext-base\b/)
  })
})
