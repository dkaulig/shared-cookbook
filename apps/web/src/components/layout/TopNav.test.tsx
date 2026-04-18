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

  // BF1 #4 — search has no real implementation yet; the icon shouldn't
  // navigate to /groups any more. Render it as a disabled button with an
  // explanatory tooltip so the user still gets a hint that search is on
  // the way without being teleported into the groups list.
  it('renders the Suchen icon as a disabled button with a "bald verfügbar" tooltip', () => {
    server.use(http.get('/api/groups/invites', () => HttpResponse.json([])))
    renderTopNav()

    const search = screen.getByRole('button', { name: /suche \(bald verfügbar\)/i })
    expect(search).toBeDisabled()
    expect(search).toHaveAttribute('title', 'Suche kommt bald')
    // Belt-and-braces: confirm the old NavLink was removed.
    expect(screen.queryByRole('link', { name: /suchen/i })).toBeNull()
  })

  it('shows the avatar initial pulled from useAuth().user.displayName', () => {
    server.use(http.get('/api/groups/invites', () => HttpResponse.json([])))
    renderTopNav()
    expect(screen.getByLabelText(/dein profil/i)).toHaveTextContent('D')
  })

  // BF1 #5 — the notification bell has no backend yet and only adds
  // visual noise. Remove it entirely; it'll come back when notifications
  // ship in Phase 2.
  it('does not render a Benachrichtigungen control', () => {
    server.use(http.get('/api/groups/invites', () => HttpResponse.json([])))
    renderTopNav()
    expect(screen.queryByRole('button', { name: /benachrichtigungen/i })).toBeNull()
    expect(screen.queryByTestId('invites-dot')).toBeNull()
  })

  it('still renders even when received-invites would have been non-empty (no bell to hang badges on)', async () => {
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
      // Brand still present and reachable.
      expect(screen.getByRole('banner')).toHaveTextContent('Familien-Kochbuch')
      expect(screen.queryByTestId('invites-dot')).toBeNull()
    })
  })
})
