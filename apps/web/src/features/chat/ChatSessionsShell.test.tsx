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
