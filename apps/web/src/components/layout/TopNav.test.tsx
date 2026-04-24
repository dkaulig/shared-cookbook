import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
  return { ...render(<TopNav />, { wrapper: Wrapper }), client }
}
// Avoid unused-import lint on helpers only referenced in some tests.
void fireEvent

describe('<TopNav />', () => {
  beforeEach(() => {
    useAuthStore.getState().setSession('tok', {
      id: 'u1',
      email: 'test@example.com',
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

  // SEARCH-1 — the Suchen icon is now an active <Link to="/suche"> that
  // routes to the cross-group search page. The old disabled-button
  // placeholder ("bald verfügbar") is gone: global search is live.
  it('renders the Suchen icon as an active Link to /suche (SEARCH-1)', () => {
    server.use(http.get('/api/groups/invites', () => HttpResponse.json([])))
    renderTopNav()

    const search = screen.getByRole('link', { name: /suche/i })
    expect(search).toHaveAttribute('href', '/suche')
    // Belt-and-braces: the disabled placeholder must be gone.
    expect(
      screen.queryByRole('button', { name: /suche \(bald verfügbar\)/i }),
    ).toBeNull()
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

  // BUG-005 regression — the shared TopNav anchors the project-wide
  // z-scale: sticky top-navs ⇒ z-20 (above page avatars at z-10, below
  // dialogs at z-50). If this drops to z-10 or below, the global avatar
  // chip starts overlapping page-scoped sub-navs again.
  it('renders as sticky top-0 z-20 with an opaque background (BUG-005)', () => {
    server.use(http.get('/api/groups/invites', () => HttpResponse.json([])))
    renderTopNav()
    const banner = screen.getByRole('banner')
    expect(banner.className).toContain('sticky')
    expect(banner.className).toContain('top-0')
    expect(banner.className).toContain('z-20')
    // Some level of background opacity so scrolled content does not bleed
    // through the bar — keeps back-arrow + settings cog readable.
    expect(banner.className).toMatch(/bg-(background|\[hsl)/)
  })

  // 2026-04-21 Pull-to-refresh substitute. Standalone-PWAs disable the
  // native pull-to-refresh gesture, so we surface a manual refresh
  // button in the TopNav instead. Clicking it invalidates the
  // TanStack-Query cache so every active query re-fetches from the
  // server.
  it('renders a refresh button that invalidates TanStack queries on click', async () => {
    server.use(http.get('/api/groups/invites', () => HttpResponse.json([])))
    const { client } = renderTopNav()
    const spy = vi.spyOn(client, 'invalidateQueries')
    const refresh = screen.getByRole('button', { name: /seite aktualisieren/i })
    const user = userEvent.setup()
    await user.click(refresh)
    expect(spy).toHaveBeenCalledTimes(1)
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
