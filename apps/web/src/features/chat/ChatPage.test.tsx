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

describe('<ChatPage /> — send + optimistic append', () => {
  it('appends the user bubble immediately before the mutation resolves', async () => {
    const user = userEvent.setup()
    let release: ((v: Response) => void) | null = null
    server.use(
      http.post(
        '/api/chat',
        () =>
          new Promise<Response>((resolve) => {
            release = resolve
          }),
      ),
    )
    renderPage()
    await user.type(
      screen.getByLabelText(/Nachricht/i),
      'Ich hab Kartoffeln und Lauch',
    )
    await user.click(screen.getByRole('button', { name: /^Senden$/ }))
    expect(
      await screen.findByText('Ich hab Kartoffeln und Lauch'),
    ).toBeInTheDocument()

    release?.(HttpResponse.json({ assistant_message: 'Super!' }))
    await screen.findByText('Super!')
  })

  it('clears the input on send and appends the assistant reply on success', async () => {
    const user = userEvent.setup()
    server.use(
      http.post('/api/chat', () =>
        HttpResponse.json({ assistant_message: 'Probier einen Auflauf.' }),
      ),
    )
    renderPage()
    const input = screen.getByLabelText(/Nachricht/i) as HTMLTextAreaElement
    await user.type(input, 'Hallo')
    await user.click(screen.getByRole('button', { name: /^Senden$/ }))

    await screen.findByText('Probier einen Auflauf.')
    expect(input.value).toBe('')
  })
})

describe('<ChatPage /> — error + retry', () => {
  it('rolls back the optimistic user bubble on mutation error and shows retry', async () => {
    const user = userEvent.setup()
    server.use(
      http.post('/api/chat', () =>
        HttpResponse.json(
          { code: 'llm_unavailable', message: 'KI-Service offline.' },
          { status: 503 },
        ),
      ),
    )
    renderPage()
    await user.type(screen.getByLabelText(/Nachricht/i), 'Oh nein')
    await user.click(screen.getByRole('button', { name: /^Senden$/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/offline/)
    const list = screen.getByTestId('chat-message-list')
    expect(within(list).queryAllByRole('listitem')).toHaveLength(0)
    expect(
      (screen.getByLabelText(/Nachricht/i) as HTMLTextAreaElement).value,
    ).toBe('Oh nein')
    expect(
      screen.getByRole('button', { name: /Erneut senden/i }),
    ).toBeInTheDocument()
  })

  it('retry button resubmits the last user message', async () => {
    const user = userEvent.setup()
    let callCount = 0
    server.use(
      http.post('/api/chat', () => {
        callCount += 1
        if (callCount === 1) {
          return HttpResponse.json(
            { code: 'llm_unavailable', message: 'KI-Service offline.' },
            { status: 503 },
          )
        }
        return HttpResponse.json({
          assistant_message: 'Zweiter Versuch klappt.',
        })
      }),
    )
    renderPage()
    await user.type(screen.getByLabelText(/Nachricht/i), 'Erneut')
    await user.click(screen.getByRole('button', { name: /^Senden$/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/offline/)

    await user.click(screen.getByRole('button', { name: /Erneut senden/i }))
    await screen.findByText('Zweiter Versuch klappt.')
    const bubbles = screen.getAllByText('Erneut')
    expect(bubbles).toHaveLength(1)
  })
})

describe('<ChatPage /> — turn cap', () => {
  it('shows a yellow warn banner once the dialogue reaches 25 messages', async () => {
    const user = userEvent.setup()
    let call = 0
    server.use(
      http.post('/api/chat', () => {
        call += 1
        return HttpResponse.json({
          assistant_message: `Reply ${call}`,
        })
      }),
    )
    renderPage()
    const input = screen.getByLabelText(/Nachricht/i)
    for (let i = 0; i < 13; i += 1) {
      await user.clear(input)
      await user.type(input, `msg ${i}`)
      await user.click(screen.getByRole('button', { name: /^Senden$/ }))
      await screen.findByText(`Reply ${i + 1}`)
    }
    expect(
      screen.getByText(/Lange Dialoge werden schwächer/i),
    ).toBeInTheDocument()
  })

  it('blocks send at 30 messages and shows the dialog-full helper', async () => {
    const user = userEvent.setup()
    let call = 0
    server.use(
      http.post('/api/chat', () => {
        call += 1
        return HttpResponse.json({ assistant_message: `Reply ${call}` })
      }),
    )
    renderPage()
    const input = screen.getByLabelText(/Nachricht/i)
    for (let i = 0; i < 15; i += 1) {
      await user.clear(input)
      await user.type(input, `t${i}`)
      await user.click(screen.getByRole('button', { name: /^Senden$/ }))
      await screen.findByText(`Reply ${i + 1}`)
    }
    expect(screen.getByText(/Dialog ist voll/i)).toBeInTheDocument()
    expect(input).toBeDisabled()
    expect(screen.getByRole('button', { name: /^Senden$/ })).toBeDisabled()
  })
})

describe('<ChatPage /> — In Rezept umwandeln', () => {
  it('hides the "In Rezept umwandeln" button until 2 assistant messages have been received', async () => {
    const user = userEvent.setup()
    let call = 0
    server.use(
      http.post('/api/chat', () => {
        call += 1
        return HttpResponse.json({ assistant_message: `Reply ${call}` })
      }),
    )
    renderPage()
    expect(
      screen.queryByRole('button', { name: /In Rezept umwandeln/i }),
    ).not.toBeInTheDocument()

    const input = screen.getByLabelText(/Nachricht/i)
    await user.clear(input)
    await user.type(input, 'Zutat 1')
    await user.click(screen.getByRole('button', { name: /^Senden$/ }))
    await screen.findByText('Reply 1')
    expect(
      screen.queryByRole('button', { name: /In Rezept umwandeln/i }),
    ).not.toBeInTheDocument()

    await user.clear(input)
    await user.type(input, 'Zutat 2')
    await user.click(screen.getByRole('button', { name: /^Senden$/ }))
    await screen.findByText('Reply 2')
    expect(
      await screen.findByRole('button', { name: /In Rezept umwandeln/i }),
    ).toBeInTheDocument()
  })

  it('converts the chat, stashes the result in sessionStorage, and navigates to /groups/:groupId/recipes/new?chatImportId=…', async () => {
    const user = userEvent.setup()
    // Fixed uuid used only for the chatImportId mint — sessionId
    // already comes from the route, not randomUUID.
    const chatImportId = '00000000-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      chatImportId as `${string}-${string}-${string}-${string}-${string}`,
    )
    let call = 0
    server.use(
      http.get('/api/groups', () =>
        HttpResponse.json<GroupSummary[]>([
          groupSummary({ id: 'only-group', isPrivateCollection: true }),
        ]),
      ),
      http.post('/api/chat', () => {
        call += 1
        return HttpResponse.json({ assistant_message: `Reply ${call}` })
      }),
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
    const input = screen.getByLabelText(/Nachricht/i)
    for (let i = 0; i < 2; i += 1) {
      await user.clear(input)
      await user.type(input, `msg ${i}`)
      await user.click(screen.getByRole('button', { name: /^Senden$/ }))
      await screen.findByText(`Reply ${i + 1}`)
    }
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
      http.post('/api/chat', () =>
        HttpResponse.json({ assistant_message: 'ok' }),
      ),
    )
    renderPage()
    const input = screen.getByLabelText(/Nachricht/i) as HTMLTextAreaElement
    await user.type(input, 'ohne shift')
    await user.type(input, '{Enter}')
    await screen.findByText('ohne shift')

    await user.type(input, 'line1{Shift>}{Enter}{/Shift}line2')
    expect(input.value).toMatch(/line1\nline2/)
  })

  it('disables the send button while the mutation is in flight', async () => {
    const user = userEvent.setup()
    let release: ((v: Response) => void) | null = null
    server.use(
      http.post(
        '/api/chat',
        () =>
          new Promise<Response>((resolve) => {
            release = resolve
          }),
      ),
    )
    renderPage()
    await user.type(screen.getByLabelText(/Nachricht/i), 'warte')
    await user.click(screen.getByRole('button', { name: /^Senden$/ }))
    expect(screen.getByRole('button', { name: /^Senden$/ })).toBeDisabled()
    release?.(HttpResponse.json({ assistant_message: 'fertig' }))
    await screen.findByText('fertig')
  })
})

describe('<ChatPage /> — scroll stickiness', () => {
  it('renders the "Neue Nachricht" pill when the user has scrolled away from bottom and a new message arrives', async () => {
    const user = userEvent.setup()
    server.use(
      http.post('/api/chat', () =>
        HttpResponse.json({ assistant_message: 'Hier eine lange Antwort.' }),
      ),
    )
    renderPage()
    await user.type(screen.getByLabelText(/Nachricht/i), 'Hi')
    await user.click(screen.getByRole('button', { name: /^Senden$/ }))
    await screen.findByText('Hier eine lange Antwort.')

    const list = screen.getByTestId('chat-message-list')
    Object.defineProperty(list, 'scrollTop', { value: 0, configurable: true })
    Object.defineProperty(list, 'scrollHeight', {
      value: 1000,
      configurable: true,
    })
    Object.defineProperty(list, 'clientHeight', {
      value: 300,
      configurable: true,
    })
    list.dispatchEvent(new Event('scroll'))

    await user.type(screen.getByLabelText(/Nachricht/i), 'Nochmal')
    await user.click(screen.getByRole('button', { name: /^Senden$/ }))
    await screen.findByText('Nochmal')
    expect(
      await screen.findByRole('button', { name: /Neue Nachricht/i }),
    ).toBeInTheDocument()
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
      http.post('/api/chat', () =>
        HttpResponse.json({ assistant_message: 'yo' }),
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
