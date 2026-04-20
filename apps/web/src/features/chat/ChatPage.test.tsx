import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ChatMessage, GroupSummary } from '@familien-kochbuch/shared'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { ChatPage } from './ChatPage'
import { recallChatImport } from './chatImportMemo'

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

function LocationProbe() {
  const loc = useLocation()
  return (
    <div data-testid="location">
      {loc.pathname}
      {loc.search}
    </div>
  )
}

function renderPage(initialUrl = '/chat') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[initialUrl]}>
          <LocationProbe />
          <Routes>
            <Route path="/chat" element={children} />
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
  // Stable sessionId across renders for easier assertions.
  const fixedUuid = '00000000-1111-2222-3333-444444444444'
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(
    fixedUuid as `${string}-${string}-${string}-${string}-${string}`,
  )
  // Default groups handler so tests that don't exercise the convert
  // path don't trigger "no matching handler" MSW warnings.
  server.use(
    http.get('/api/groups', () =>
      HttpResponse.json<GroupSummary[]>([groupSummary({})]),
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
  it('renders the "Rezept-Chat" title and an empty-state welcome hint', async () => {
    renderPage()
    expect(
      screen.getByRole('heading', { name: /Rezept-Chat/i }),
    ).toBeInTheDocument()
    // Empty-state copy — German, invites the user to start.
    expect(screen.getByText(/was möchtest du heute kochen/i)).toBeInTheDocument()
    // Send button exists but disabled until the user types.
    const send = screen.getByRole('button', { name: /Senden/i })
    expect(send).toBeDisabled()
  })

  it('writes the session id into the URL so reload keeps the same session', async () => {
    renderPage()
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent(/session=/i)
    })
  })

  it('reuses the session id from the URL if present instead of generating a new one', async () => {
    renderPage('/chat?session=existing-session-id')
    // The URL stays unchanged (we don't overwrite a provided id).
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent(
        /session=existing-session-id/,
      )
    })
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
    await user.click(screen.getByRole('button', { name: /Senden/i }))
    // The user bubble should render before the network resolves.
    expect(
      await screen.findByText('Ich hab Kartoffeln und Lauch'),
    ).toBeInTheDocument()

    // Now release the mutation so the test cleanup is clean.
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
    await user.click(screen.getByRole('button', { name: /Senden/i }))

    await screen.findByText('Probier einen Auflauf.')
    expect(input.value).toBe('')
  })

  it('posts the full history on the second turn (backend is stateless)', async () => {
    const user = userEvent.setup()
    const bodies: ChatMessage[][] = []
    server.use(
      http.post('/api/chat', async ({ request }) => {
        const body = (await request.json()) as { messages: ChatMessage[] }
        bodies.push(body.messages)
        return HttpResponse.json({
          assistant_message: `turn ${bodies.length}`,
        })
      }),
    )
    renderPage()
    const input = screen.getByLabelText(/Nachricht/i)
    await user.type(input, 'Erste Frage')
    await user.click(screen.getByRole('button', { name: /Senden/i }))
    await screen.findByText('turn 1')

    await user.type(input, 'Zweite Frage')
    await user.click(screen.getByRole('button', { name: /Senden/i }))
    await screen.findByText('turn 2')

    expect(bodies).toHaveLength(2)
    // First call: just the user message.
    expect(bodies[0]).toEqual([{ role: 'user', content: 'Erste Frage' }])
    // Second call carries the assistant's reply + the new user turn.
    expect(bodies[1]).toEqual([
      { role: 'user', content: 'Erste Frage' },
      { role: 'assistant', content: 'turn 1' },
      { role: 'user', content: 'Zweite Frage' },
    ])
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
    await user.click(screen.getByRole('button', { name: /Senden/i }))

    // Error alert appears + the optimistic bubble is rolled back.
    expect(await screen.findByRole('alert')).toHaveTextContent(/offline/)
    // The rollback means the chat-message-list has no <li> with "Oh nein".
    const list = screen.getByTestId('chat-message-list')
    expect(within(list).queryAllByRole('listitem')).toHaveLength(0)
    // The input preserves the text so the retry button can resubmit.
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
        return HttpResponse.json({ assistant_message: 'Zweiter Versuch klappt.' })
      }),
    )
    renderPage()
    await user.type(screen.getByLabelText(/Nachricht/i), 'Erneut')
    await user.click(screen.getByRole('button', { name: /^Senden$/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/offline/)

    await user.click(screen.getByRole('button', { name: /Erneut senden/i }))
    await screen.findByText('Zweiter Versuch klappt.')
    // The user bubble is back (and only one, not two).
    const bubbles = screen.getAllByText('Erneut')
    expect(bubbles).toHaveLength(1)
  })
})

describe('<ChatPage /> — turn cap', () => {
  function preloadHistory(turnCount: number) {
    const msgs: ChatMessage[] = []
    for (let i = 0; i < turnCount; i += 1) {
      msgs.push({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `msg ${i}`,
      })
    }
    // The URL is the only supported surface for pre-existing state in
    // this slice, but a chat at warn threshold is an organic multi-turn
    // scenario — drive it by actually sending messages instead of
    // faking state.
    return msgs
  }

  it('shows a yellow warn banner once the dialogue reaches 25 messages', async () => {
    const user = userEvent.setup()
    preloadHistory(0)
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
    // Send 13 user turns → 26 messages (13 user + 13 assistant).
    // The warn threshold (25) trips after the 12th user send (12+12=24 ok,
    // 13th user send creates a 25-message history when appended
    // optimistically). Send 13.
    for (let i = 0; i < 13; i += 1) {
      await user.clear(input)
      await user.type(input, `msg ${i}`)
      await user.click(screen.getByRole('button', { name: /^Senden$/i }))
      await screen.findByText(`Reply ${i + 1}`)
    }
    // Now there are 26 messages in history → warn.
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
    // Send 15 user turns → 30 messages. The 15th send completes → after
    // that the history is exactly 30 and the next user turn is blocked.
    for (let i = 0; i < 15; i += 1) {
      await user.clear(input)
      await user.type(input, `t${i}`)
      await user.click(screen.getByRole('button', { name: /^Senden$/i }))
      await screen.findByText(`Reply ${i + 1}`)
    }
    expect(
      screen.getByText(/Dialog ist voll/i),
    ).toBeInTheDocument()
    // Input + send are both disabled at the hard cap.
    expect(input).toBeDisabled()
    expect(screen.getByRole('button', { name: /^Senden$/i })).toBeDisabled()
  })

  it('"Neu starten" clears messages and generates a new sessionId', async () => {
    const user = userEvent.setup()
    let call = 0
    server.use(
      http.post('/api/chat', () => {
        call += 1
        return HttpResponse.json({ assistant_message: `Reply ${call}` })
      }),
    )
    // Mock the id so we can see it change after reset.
    const ids = [
      '00000000-aaaa-aaaa-aaaa-000000000000',
      '00000000-bbbb-bbbb-bbbb-000000000000',
    ]
    let idx = 0
    vi.spyOn(crypto, 'randomUUID').mockImplementation(
      () => ids[idx++ % ids.length] as `${string}-${string}-${string}-${string}-${string}`,
    )
    renderPage()
    const input = screen.getByLabelText(/Nachricht/i)
    // Get into warn territory so the "Neu starten" affordance surfaces.
    for (let i = 0; i < 13; i += 1) {
      await user.clear(input)
      await user.type(input, `msg ${i}`)
      await user.click(screen.getByRole('button', { name: /^Senden$/i }))
      await screen.findByText(`Reply ${i + 1}`)
    }
    // "Neu starten" button is visible near the warn banner.
    const reset = screen.getByRole('button', { name: /Neu starten/i })
    await user.click(reset)
    // Messages cleared.
    expect(screen.queryByText('msg 0')).not.toBeInTheDocument()
    // URL now carries the second uuid.
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(
        'session=00000000-bbbb-bbbb-bbbb-000000000000',
      ),
    )
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
    // Zero assistant turns: button absent.
    expect(
      screen.queryByRole('button', { name: /In Rezept umwandeln/i }),
    ).not.toBeInTheDocument()

    const input = screen.getByLabelText(/Nachricht/i)
    await user.clear(input)
    await user.type(input, 'Zutat 1')
    await user.click(screen.getByRole('button', { name: /^Senden$/i }))
    await screen.findByText('Reply 1')
    // Still hidden after 1 assistant message.
    expect(
      screen.queryByRole('button', { name: /In Rezept umwandeln/i }),
    ).not.toBeInTheDocument()

    await user.clear(input)
    await user.type(input, 'Zutat 2')
    await user.click(screen.getByRole('button', { name: /^Senden$/i }))
    await screen.findByText('Reply 2')
    // Now visible — 2 assistant messages → dialogue has substance.
    expect(
      await screen.findByRole('button', { name: /In Rezept umwandeln/i }),
    ).toBeInTheDocument()
  })

  it('converts the chat, stashes the result in sessionStorage, and navigates to /groups/:groupId/recipes/new?chatImportId=…', async () => {
    const user = userEvent.setup()
    // Fixed uuid returns: first for session, second for chatImportId.
    const ids = [
      '00000000-aaaa-aaaa-aaaa-aaaaaaaaaaaa', // session
      '00000000-bbbb-bbbb-bbbb-bbbbbbbbbbbb', // chatImportId
    ]
    let idx = 0
    vi.spyOn(crypto, 'randomUUID').mockImplementation(
      () => ids[idx++ % ids.length] as `${string}-${string}-${string}-${string}-${string}`,
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
      http.post('/api/chat/:sessionId/to-recipe', () =>
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
      await user.click(screen.getByRole('button', { name: /^Senden$/i }))
      await screen.findByText(`Reply ${i + 1}`)
    }
    await user.click(
      await screen.findByRole('button', { name: /In Rezept umwandeln/i }),
    )

    // Navigates to the recipe form with the transient chat-import id.
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(
        /\/groups\/only-group\/recipes\/new\?chatImportId=00000000-bbbb-bbbb-bbbb-bbbbbbbbbbbb/,
      ),
    )
    // And stashes the ExtractionResult in sessionStorage under that id.
    const recalled = recallChatImport(
      '00000000-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    )
    expect(recalled).not.toBeNull()
    expect(recalled!.groupId).toBe('only-group')
    expect(recalled!.result.recipe.title).toBe('Kartoffel-Lauch-Auflauf')
  })

  it('opens the group picker when the user belongs to more than one group', async () => {
    const user = userEvent.setup()
    let call = 0
    server.use(
      http.get('/api/groups', () =>
        HttpResponse.json<GroupSummary[]>([
          groupSummary({ id: 'ga', name: 'Alpha' }),
          groupSummary({ id: 'gb', name: 'Beta' }),
        ]),
      ),
      http.post('/api/chat', () => {
        call += 1
        return HttpResponse.json({ assistant_message: `Reply ${call}` })
      }),
      http.post('/api/chat/:sessionId/to-recipe', () =>
        HttpResponse.json({
          recipe: {
            title: 'T',
            description: null,
            servings: 4,
            difficulty: null,
            prep_minutes: null,
            cook_minutes: null,
            ingredients: [],
            steps: [],
            tags: [],
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
      await user.click(screen.getByRole('button', { name: /^Senden$/i }))
      await screen.findByText(`Reply ${i + 1}`)
    }
    await user.click(
      await screen.findByRole('button', { name: /In Rezept umwandeln/i }),
    )
    // Picker dialog appears.
    expect(
      await screen.findByText(/In welcher Gruppe/i),
    ).toBeInTheDocument()
    // Pick Beta.
    await user.click(screen.getByRole('button', { name: /Beta/ }))
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(
        /\/groups\/gb\/recipes\/new/,
      ),
    )
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
    // Shift+Enter must NOT submit → the textarea still holds the
    // multi-line input.
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
    await user.click(screen.getByRole('button', { name: /^Senden$/i }))
    // In flight → disabled.
    expect(screen.getByRole('button', { name: /^Senden$/i })).toBeDisabled()
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
    // Send once so a message list exists (and so the scroller has
    // content to scroll).
    await user.type(screen.getByLabelText(/Nachricht/i), 'Hi')
    await user.click(screen.getByRole('button', { name: /^Senden$/i }))
    await screen.findByText('Hier eine lange Antwort.')

    // Simulate "user scrolled up" by dispatching a scroll event with
    // a scrollTop far enough from the bottom + a large scrollHeight.
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

    // Trigger a second message — the pill must show.
    await user.type(screen.getByLabelText(/Nachricht/i), 'Nochmal')
    await user.click(screen.getByRole('button', { name: /^Senden$/i }))
    await screen.findByText('Nochmal')
    // Pill appears because we're not pinned to bottom.
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
    // Enforce that it's an actionable button — the click itself would
    // call navigate(-1) but MemoryRouter has no previous entry, so we
    // just assert the node exists + accepts a click.
    await user.click(backBtn)
  })

  it('renders nothing that writes to localStorage (privacy)', async () => {
    const user = userEvent.setup()
    server.use(
      http.post('/api/chat', () =>
        HttpResponse.json({ assistant_message: 'yo' }),
      ),
    )
    renderPage()
    await user.type(screen.getByLabelText(/Nachricht/i), 'something')
    await user.click(screen.getByRole('button', { name: /^Senden$/i }))
    await screen.findByText('yo')
    // Scan localStorage for any chat residue.
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const k = window.localStorage.key(i) ?? ''
      expect(k).not.toMatch(/chat/i)
    }
  })
})

// Silence a potential "unused" lint on this helper — referenced above.
void within

describe('<ChatPage /> — BUG-026 regression: snake_case wire + undefined-content history', () => {
  // Two-faces-of-one-bug: Python emits `{ "assistant_message": "…" }`
  // (snake_case); the .NET proxy forwards verbatim. Before the wire
  // mapper, the UI read `res.assistantMessage` → undefined, so (1) the
  // assistant bubble rendered empty and (2) the optimistic history
  // append pushed `{ role: 'assistant', content: undefined }` into
  // state, which on the next turn serialised without a `content` key
  // and the backend rejected it as `invalid_message`.
  it('renders the assistant bubble from snake_case wire and keeps history well-formed across turns', async () => {
    const user = userEvent.setup()
    const bodies: { messages: ChatMessage[] }[] = []
    let call = 0
    server.use(
      http.post('/api/chat', async ({ request }) => {
        const body = (await request.json()) as { messages: ChatMessage[] }
        bodies.push(body)
        call += 1
        return HttpResponse.json({
          assistant_message: call === 1 ? 'Ja gerne' : 'Klar, weiter geht es',
        })
      }),
    )
    renderPage()

    const input = screen.getByLabelText(/Nachricht/i)
    await user.type(input, 'Hi')
    await user.click(screen.getByRole('button', { name: /^Senden$/i }))

    // Symptom #1: assistant bubble must render with the real text, not
    // an empty node from a `content: undefined` assistant message.
    expect(await screen.findByText('Ja gerne')).toBeInTheDocument()

    await user.type(input, 'weiter')
    await user.click(screen.getByRole('button', { name: /^Senden$/i }))
    await screen.findByText('Klar, weiter geht es')

    // Symptom #2: the second-turn POST body must carry a well-formed
    // history — every message has a non-empty string `content`. No
    // entry with `content === undefined` or a missing `content` key.
    expect(bodies).toHaveLength(2)
    const secondBody = bodies[1]
    expect(secondBody.messages).toEqual([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Ja gerne' },
      { role: 'user', content: 'weiter' },
    ])
    for (const msg of secondBody.messages) {
      expect(msg).toHaveProperty('content')
      expect(typeof msg.content).toBe('string')
      expect(msg.content.length).toBeGreaterThan(0)
    }
  })
})

describe('<ChatPage /> — BUG-001 regression: mobile viewport sizing', () => {
  // The bug: on iOS Safari + Chrome Android the chat input was hidden
  // behind the dynamic browser bottom bar because the page sized itself
  // with `100vh` (static) and ignored `env(safe-area-inset-bottom)`.
  // Fix: switch to `100dvh` (dynamic viewport units) AND add safe-area
  // padding so the input is never overlapped by browser chrome or the
  // iOS home indicator. This grep-style assertion fails fast if anyone
  // reverts to `vh` or drops the safe-area inset.
  const source = readFileSync(
    resolve(__dirname, './ChatPage.tsx'),
    'utf8',
  )

  it('uses dynamic viewport height units (100dvh), not static 100vh', () => {
    expect(source).toMatch(/100dvh/)
    // Guard: no rogue `100vh` in className/calc usage (would re-
    // introduce the bug — `vh` ignores browser-chrome retraction). We
    // scan only for `100vh` followed by a non-`d` boundary char that
    // appears in real class strings (`)`, `]`, ` `, `;`, `,`) so the
    // word `100vh` mentioned in this file's docblock prose doesn't
    // trip us up.
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
