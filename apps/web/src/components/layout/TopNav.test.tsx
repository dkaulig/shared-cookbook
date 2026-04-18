import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { TopNav } from './TopNav'

function renderTopNav() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    )
  }
  return render(<TopNav />, { wrapper: Wrapper })
}

describe('<TopNav />', () => {
  beforeEach(() => {
    useAuthStore.getState().setSession('tok', {
      id: 'u1',
      email: 'david@kaulig.de',
      displayName: 'David',
      role: 'User',
    })
  })
  afterEach(() => {
    server.resetHandlers()
    useAuthStore.getState().clear()
  })

  it('renders the Familien-Kochbuch brand name in the banner', () => {
    server.use(http.get('/api/groups/invites', () => HttpResponse.json([])))
    renderTopNav()

    const banner = screen.getByRole('banner')
    expect(banner).toHaveTextContent('Familien-Kochbuch')
    // Chef-hat logo is an <svg> inside the banner's amber tile.
    expect(banner.querySelector('svg')).not.toBeNull()
  })

  it('exposes the Suchen and Benachrichtigungen controls with aria-labels', () => {
    server.use(http.get('/api/groups/invites', () => HttpResponse.json([])))
    renderTopNav()

    // Suchen routes to /groups (list view) for now; Benachrichtigungen
    // is a button that will open a notifications tray in DS7.
    expect(screen.getByRole('link', { name: /suchen/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /benachrichtigungen/i })).toBeInTheDocument()
  })

  it('shows the avatar initial pulled from useAuth().user.displayName', () => {
    server.use(http.get('/api/groups/invites', () => HttpResponse.json([])))
    renderTopNav()
    expect(screen.getByLabelText(/dein profil/i)).toHaveTextContent('D')
  })

  it('hides the bell badge when there are no pending invites', async () => {
    server.use(http.get('/api/groups/invites', () => HttpResponse.json([])))
    renderTopNav()

    await waitFor(() => {
      const bell = screen.getByRole('button', { name: /benachrichtigungen/i })
      expect(bell.querySelector('[data-testid="invites-dot"]')).toBeNull()
    })
  })

  it('shows the red bell badge when there is at least one pending invite', async () => {
    server.use(
      http.get('/api/groups/invites', () =>
        HttpResponse.json([
          {
            id: 'i1',
            groupId: 'g1',
            groupName: 'Backkurs-Crew',
            inviterDisplayName: 'Maren',
            createdAt: new Date().toISOString(),
          },
        ]),
      ),
    )

    renderTopNav()
    await waitFor(() => {
      const bell = screen.getByRole('button', { name: /benachrichtigungen/i })
      expect(bell.querySelector('[data-testid="invites-dot"]')).not.toBeNull()
    })
  })
})
