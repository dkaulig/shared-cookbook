import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { ShareTargetPage } from './ShareTargetPage'

/**
 * SHARE-0 — `/share-target` route tests.
 *
 * Covers:
 *   - authenticated happy paths (url + text + regex-fallback) → redirect
 *     to `/rezepte/import/url?url=<extracted>` with `replace: true`
 *     semantics (we don't directly test history.replace here; the
 *     production component is wired with `replace: true` and the route
 *     itself mounts behind a redirect).
 *   - unauthenticated → `/login?next=…` with the original share-target
 *     query preserved so the user lands back on the share flow after
 *     login.
 *   - no usable payload → German error page renders + no redirect.
 *   - hostile `javascript:` payload → error page renders, never reaches
 *     the import pipeline.
 */
function LocationProbe() {
  const loc = useLocation()
  // Data-only probe — never renders the raw search string as text so
  // hostile payloads never show up via queryByText in test assertions.
  return (
    <div
      data-testid="location"
      data-pathname={loc.pathname}
      data-search={loc.search}
    />
  )
}

function renderPage(initialEntry: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <LocationProbe />
          <Routes>
            <Route path="/share-target" element={children} />
            <Route
              path="/rezepte/import/url"
              element={<div data-testid="import-url-page">import-url</div>}
            />
            <Route
              path="/login"
              element={<div data-testid="login-page">login</div>}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    )
  }
  return render(<ShareTargetPage />, { wrapper: Wrapper })
}

describe('<ShareTargetPage />', () => {
  beforeEach(() => {
    useAuthStore.getState().clear()
    // Default: silent-refresh says "no session". Individual tests can
    // override via server.use(...) if they need authenticated state
    // without pre-seeding the auth store.
    server.use(
      http.post('/api/auth/refresh', () => new HttpResponse(null, { status: 401 })),
    )
  })
  afterEach(() => {
    useAuthStore.getState().clear()
  })

  function signIn() {
    useAuthStore.getState().setSession('tok', {
      id: 'u1',
      email: 'u1@ex.com',
      displayName: 'U',
      role: 'User',
    })
  }

  it('redirects authenticated users with ?url= to the import-url page', async () => {
    signIn()
    renderPage('/share-target?url=https://fb.com/x')

    await waitFor(() => {
      expect(screen.getByTestId('import-url-page')).toBeInTheDocument()
    })
    const loc = screen.getByTestId('location')
    expect(loc.getAttribute('data-pathname')).toBe('/rezepte/import/url')
    expect(loc.getAttribute('data-search')).toBe(
      '?url=https%3A%2F%2Ffb.com%2Fx',
    )
  })

  it('extracts the URL from a multi-line ?text= payload and redirects', async () => {
    signIn()
    renderPage(
      '/share-target?text=' +
        encodeURIComponent('Check this out!\nhttps://fb.com/x rest'),
    )

    await waitFor(() => {
      expect(screen.getByTestId('import-url-page')).toBeInTheDocument()
    })
    const loc = screen.getByTestId('location')
    expect(loc.getAttribute('data-search')).toBe(
      '?url=https%3A%2F%2Ffb.com%2Fx',
    )
  })

  it('redirects unauthenticated users to /login with the share-target path in ?next=', async () => {
    renderPage('/share-target?url=https://fb.com/x')

    await waitFor(() => {
      expect(screen.getByTestId('login-page')).toBeInTheDocument()
    })
    const loc = screen.getByTestId('location')
    expect(loc.getAttribute('data-pathname')).toBe('/login')
    // The original share-target search must be preserved inside ?next=
    // so the user lands back on the correct share after login.
    expect(loc.getAttribute('data-search')).toContain('next=')
    expect(loc.getAttribute('data-search')).toContain(
      encodeURIComponent('/share-target?url=https://fb.com/x'),
    )
  })

  it('renders the German empty-state when no usable payload is present', () => {
    signIn()
    renderPage('/share-target')

    // Stays on /share-target — no redirect.
    const loc = screen.getByTestId('location')
    expect(loc.getAttribute('data-pathname')).toBe('/share-target')
    // German copy + CTA to manual import.
    expect(
      screen.getByText(/Kein Link in der Freigabe gefunden/i),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: /manuell importieren/i }),
    ).toHaveAttribute('href', '/rezepte/import/url')
  })

  it('rejects a javascript: payload and renders the error page (no redirect)', () => {
    signIn()
    renderPage('/share-target?url=javascript:alert(1)')

    const loc = screen.getByTestId('location')
    expect(loc.getAttribute('data-pathname')).toBe('/share-target')
    expect(
      screen.getByText(/Kein Link in der Freigabe gefunden/i),
    ).toBeInTheDocument()
    // Defensive: the hostile URL must not be rendered back to the DOM
    // anywhere on the page (no XSS via rendering).
    expect(screen.queryByText(/alert\(1\)/i)).not.toBeInTheDocument()
  })
})
