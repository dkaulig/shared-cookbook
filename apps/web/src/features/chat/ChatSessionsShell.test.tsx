import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ChatSessionListItem } from '@familien-kochbuch/shared'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { MOBILE_QUERY } from '@/lib/useIsMobile'
import { ChatSessionsShell } from './ChatSessionsShell'

// REL-3e — i18n is bootstrapped globally in `src/test/setup.ts`
// (pinned to `de`), so no per-file `beforeAll(createI18n)` is needed
// for `classifyMutationError` to resolve `errors.json` keys.

function row(over: Partial<ChatSessionListItem> = {}): ChatSessionListItem {
  return {
    id: 's1',
    title: null,
    messageCount: 0,
    createdAt: '2026-04-20T10:00:00Z',
    updatedAt: '2026-04-20T10:00:00Z',
    ...over,
  }
}

/**
 * Mock `window.matchMedia` so tests can choose between mobile/desktop
 * layouts. We key off the query string exactly like {@link useIsMobile}.
 */
function setViewport(isMobile: boolean) {
  vi.stubGlobal(
    'matchMedia',
    (q: string) => ({
      matches: q === MOBILE_QUERY ? isMobile : false,
      media: q,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  )
}

function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="location">{loc.pathname}</div>
}

function renderShell(opts: { activeSessionId?: string; isMobile?: boolean } = {}) {
  setViewport(opts.isMobile ?? false)
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/chat/initial']}>
          <LocationProbe />
          <Routes>
            <Route path="/chat/:sessionId" element={children} />
            <Route path="/chat" element={<div data-testid="chat-root" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    )
  }
  return render(
    <ChatSessionsShell activeSessionId={opts.activeSessionId}>
      <div data-testid="chat-child" />
    </ChatSessionsShell>,
    { wrapper: Wrapper },
  )
}

beforeEach(() => {
  useAuthStore.setState({
    accessToken: 't',
    user: { id: 'u1', email: 'u1@ex.com', displayName: 'U', role: 'User' },
  })
  server.use(
    http.get('/api/chat/sessions', () =>
      HttpResponse.json<ChatSessionListItem[]>([
        row({ id: 's1', title: 'Session 1' }),
        row({ id: 's2', title: 'Session 2' }),
      ]),
    ),
  )
})

afterEach(() => {
  server.resetHandlers()
  useAuthStore.getState().clear()
  vi.unstubAllGlobals()
})

describe('<ChatSessionsShell /> — desktop', () => {
  it('renders the sidebar aside + the children side-by-side at md+', async () => {
    renderShell({ isMobile: false })
    // Sidebar with its landmark is visible.
    expect(
      await screen.findByRole('complementary', { name: /Unterhaltungen/ }),
    ).toBeInTheDocument()
    expect(screen.getByTestId('chat-child')).toBeInTheDocument()
    // Mobile drawer trigger should NOT be present on desktop.
    expect(
      screen.queryByTestId('chat-sessions-drawer-trigger'),
    ).not.toBeInTheDocument()
  })

  // ── TABLET-2 — SplitPane adoption ────────────────────────────────
  //
  // Per the TABLET-2 spec, the desktop sidebar+conversation layout is
  // migrated off the ad-hoc `flex h-full w-full` scaffold onto the
  // shared <SplitPane /> primitive so future width-token tweaks apply
  // uniformly across every md:+ two-column page.
  it('TABLET-2 md+: renders the Unterhaltungen + Unterhaltung SplitPane regions', async () => {
    renderShell({ isMobile: false })
    await screen.findByRole('complementary', { name: /Unterhaltungen/ })
    // Two named landmark regions straight from <SplitPane />.
    expect(
      screen.getByRole('region', { name: /sitzungen-liste/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('region', { name: /aktuelle unterhaltung/i }),
    ).toBeInTheDocument()
  })

  it('navigates to /chat/:sessionId when a row is clicked', async () => {
    const user = userEvent.setup()
    renderShell({ isMobile: false, activeSessionId: 's1' })
    const row = (await screen.findAllByTestId('chat-session-row'))[1]!
    await user.click(row)
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/chat/s2'),
    )
  })

  it('creates a new session and navigates to its URL', async () => {
    const user = userEvent.setup()
    server.use(
      http.post('/api/chat/sessions', () =>
        HttpResponse.json({ sessionId: 'newly-created' }),
      ),
    )
    renderShell({ isMobile: false })
    await screen.findAllByTestId('chat-session-row')
    await user.click(screen.getByRole('button', { name: /Neue Unterhaltung/ }))
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(
        '/chat/newly-created',
      ),
    )
  })
})

describe('<ChatSessionsShell /> — mobile', () => {
  it('renders a drawer trigger instead of a sidebar at narrow widths', async () => {
    renderShell({ isMobile: true })
    await screen.findByTestId('chat-sessions-drawer-trigger')
    expect(
      screen.queryByRole('complementary', { name: /Unterhaltungen/ }),
    ).not.toBeInTheDocument()
  })

  it('opens + closes the drawer via the trigger + the close button', async () => {
    const user = userEvent.setup()
    renderShell({ isMobile: true })
    const trigger = await screen.findByTestId('chat-sessions-drawer-trigger')

    expect(screen.queryByTestId('chat-sessions-drawer')).not.toBeInTheDocument()
    await user.click(trigger)
    expect(screen.getByTestId('chat-sessions-drawer')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Schließen/ }))
    await waitFor(() =>
      expect(
        screen.queryByTestId('chat-sessions-drawer'),
      ).not.toBeInTheDocument(),
    )
  })

  it('selecting a session in the drawer navigates + closes the drawer', async () => {
    const user = userEvent.setup()
    renderShell({ isMobile: true, activeSessionId: 's1' })
    await user.click(
      await screen.findByTestId('chat-sessions-drawer-trigger'),
    )
    const rows = await screen.findAllByTestId('chat-session-row')
    await user.click(rows[1]!)
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/chat/s2'),
    )
    expect(screen.queryByTestId('chat-sessions-drawer')).not.toBeInTheDocument()
  })
})

// REL-3d — the rename flow previously surfaced the backend's raw
// English Dev-Message (`apiErr.message`) verbatim in the dialog. Post
// REL-4 the server emits English copy ("Invalid title.") that must be
// routed through `classifyMutationError` → localised `errors.json`
// entry so the user sees the German translation instead.
describe('<ChatSessionsShell /> — REL-3d rename error localisation', () => {
  it('shows the translated errors:invalid_title copy when the rename PATCH 400s', async () => {
    const user = userEvent.setup()
    server.use(
      http.patch('/api/chat/sessions/:sessionId', () =>
        HttpResponse.json(
          {
            code: 'invalid_title',
            message: 'Invalid title.',
            status: 400,
          },
          { status: 400 },
        ),
      ),
    )
    renderShell({ isMobile: false })
    // Open the rename dialog from the first row's pencil. The aria-
    // label pattern in `ChatSessionsList` is `Umbenennen: <title>`.
    const renameButtons = await screen.findAllByRole('button', {
      name: /^Umbenennen:/i,
    })
    await user.click(renameButtons[0]!)
    const input = await screen.findByLabelText(/Titel/i)
    await user.clear(input)
    await user.type(input, 'Neuer Titel der viel zu lang ist')
    await user.click(screen.getByRole('button', { name: /Speichern/i }))

    // The localised German copy from errors.json must appear.
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/Ungültiger Titel\./)
    // And the raw backend English must NOT leak through.
    expect(alert).not.toHaveTextContent(/Invalid title\./)
  })
})
