import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ChatSessionListItem } from '@shared-cookbook/shared'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { ChatIndexRedirect } from './ChatIndexRedirect'

function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="location">{loc.pathname}</div>
}

function renderRedirect() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/chat']}>
          <LocationProbe />
          <Routes>
            <Route path="/chat" element={children} />
            <Route
              path="/chat/:sessionId"
              element={<div data-testid="chat-detail" />}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    )
  }
  return render(<ChatIndexRedirect />, { wrapper: Wrapper })
}

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

beforeEach(() => {
  useAuthStore.setState({
    accessToken: 't',
    user: { id: 'u1', email: 'u1@ex.com', displayName: 'U', role: 'User' },
  })
})

afterEach(() => {
  server.resetHandlers()
  useAuthStore.getState().clear()
})

describe('<ChatIndexRedirect />', () => {
  it('redirects to the newest session when sessions exist (declarative <Navigate>)', async () => {
    server.use(
      http.get('/api/chat/sessions', () =>
        HttpResponse.json<ChatSessionListItem[]>([
          row({ id: 'newest' }),
          row({ id: 'older' }),
        ]),
      ),
    )
    renderRedirect()
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/chat/newest'),
    )
  })

  it('creates a new session and redirects when the user has none (useEffect-driven navigate)', async () => {
    let posts = 0
    server.use(
      http.get('/api/chat/sessions', () =>
        HttpResponse.json<ChatSessionListItem[]>([]),
      ),
      http.post('/api/chat/sessions', () => {
        posts += 1
        return HttpResponse.json({ sessionId: 'fresh-created' })
      }),
    )
    renderRedirect()
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(
        '/chat/fresh-created',
      ),
    )
    expect(posts).toBe(1)
  })
})
