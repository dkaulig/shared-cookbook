import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { GroupSummary } from '@familien-kochbuch/shared'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { ShareTargetPage } from './ShareTargetPage'
import {
  deleteSharePayload,
  saveSharePayload,
} from './sharePayloadStore'

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
  // `state` goes through JSON.stringify which erases Blob prototypes —
  // we keep a separate slot for the raw `stagedBlobs` count so a
  // passing assertion doesn't depend on JSON serialising File/Blob.
  const state = (loc.state ?? null) as null | { stagedBlobs?: unknown[] }
  const stagedCount = Array.isArray(state?.stagedBlobs)
    ? state!.stagedBlobs.length
    : ''
  return (
    <div
      data-testid="location"
      data-pathname={loc.pathname}
      data-search={loc.search}
      data-staged-count={String(stagedCount)}
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
              path="/rezepte/import"
              element={<div data-testid="import-list-page">import-list</div>}
            />
            <Route
              path="/rezepte/import/url"
              element={<div data-testid="import-url-page">import-url</div>}
            />
            <Route
              path="/rezepte/import/photos"
              element={
                <div data-testid="import-photos-page">import-photos</div>
              }
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

  /**
   * SHARE-1 — file-share branch. The SW writes blobs to
   * `sharePayloadStore` keyed by a timestamp then 303s to
   * `/share-target?payload-key=<timestamp>`. The page reads the blobs
   * back, hands them to the photo-import staging grid, and deletes
   * the IDB record so a Back-button can't double-consume them.
   */
  describe('SHARE-1 — ?payload-key= branch', () => {
    const PAYLOAD_KEY = 424242

    afterEach(async () => {
      await deleteSharePayload(PAYLOAD_KEY)
    })

    it('reads stashed blobs and navigates to /rezepte/import/photos with state.stagedBlobs', async () => {
      signIn()
      const a = new File(['hello'], 'a.jpg', { type: 'image/jpeg' })
      const b = new File(['world'], 'b.png', { type: 'image/png' })
      await saveSharePayload(PAYLOAD_KEY, [a, b])

      renderPage('/share-target?payload-key=' + PAYLOAD_KEY)

      await waitFor(() => {
        expect(screen.getByTestId('import-photos-page')).toBeInTheDocument()
      })
      const loc = screen.getByTestId('location')
      expect(loc.getAttribute('data-pathname')).toBe('/rezepte/import/photos')
      expect(loc.getAttribute('data-staged-count')).toBe('2')
    })

    it('renders the German empty-state when the payload-key has no record (expired / purged)', async () => {
      signIn()
      renderPage('/share-target?payload-key=999999999')
      // Await one tick so the async IDB read resolves and the page
      // drops out of its busy state.
      await waitFor(() =>
        expect(
          screen.getByText(/Bild-Freigabe abgelaufen/i),
        ).toBeInTheDocument(),
      )
    })

    it('reading the payload deletes the IDB record (prevents Back-button double-consumption)', async () => {
      signIn()
      const a = new File(['hello'], 'a.jpg', { type: 'image/jpeg' })
      await saveSharePayload(PAYLOAD_KEY, [a])

      renderPage('/share-target?payload-key=' + PAYLOAD_KEY)
      await waitFor(() =>
        expect(screen.getByTestId('import-photos-page')).toBeInTheDocument(),
      )

      // IDB record must be gone after the handoff.
      const { readSharePayload } = await import('./sharePayloadStore')
      expect(await readSharePayload(PAYLOAD_KEY)).toBeNull()
    })
  })

  /**
   * SHARE-2 — multi-URL picker.
   *
   * When the share payload contains 2-10 usable http(s) URLs, render
   * a picker so the user can choose one (or fire them all as batched
   * URL imports). Attacker-controlled payload — per-URL sanitise is
   * identical to SHARE-0 and the 10-item cap is a sanity guard.
   */
  describe('SHARE-2 — multi-URL picker', () => {
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

    it('renders the picker with 2 cards when ?text= has two URLs', async () => {
      signIn()
      renderPage(
        '/share-target?text=' +
          encodeURIComponent('https://fb.com/x\nhttps://ig.com/y'),
      )

      await waitFor(() => {
        expect(
          screen.getByRole('heading', {
            name: /Welches Rezept willst du importieren\?/i,
          }),
        ).toBeInTheDocument()
      })
      // Two picker cards — each exposed as a button with the URL.
      const cards = screen.getAllByTestId('share-picker-card')
      expect(cards).toHaveLength(2)
      // Stays on /share-target — no auto-redirect for multi-URL.
      const loc = screen.getByTestId('location')
      expect(loc.getAttribute('data-pathname')).toBe('/share-target')
    })

    it('tapping a picker card redirects to /rezepte/import/url?url=<that one>', async () => {
      signIn()
      const user = userEvent.setup()
      renderPage(
        '/share-target?text=' +
          encodeURIComponent('https://fb.com/x\nhttps://ig.com/y'),
      )
      await waitFor(() =>
        expect(screen.getAllByTestId('share-picker-card')).toHaveLength(2),
      )
      const [first] = screen.getAllByTestId('share-picker-card')
      await user.click(first!)

      await waitFor(() =>
        expect(screen.getByTestId('import-url-page')).toBeInTheDocument(),
      )
      const loc = screen.getByTestId('location')
      expect(loc.getAttribute('data-pathname')).toBe('/rezepte/import/url')
      expect(loc.getAttribute('data-search')).toBe(
        '?url=https%3A%2F%2Ffb.com%2Fx',
      )
    })

    it('"Alle importieren" fires N POSTs and navigates to /rezepte/import', async () => {
      signIn()
      const user = userEvent.setup()
      const enqueued: string[] = []
      server.use(
        http.get('/api/groups', () =>
          HttpResponse.json<GroupSummary[]>([groupSummary({})]),
        ),
        http.post('/api/recipes/import/url', async ({ request }) => {
          const body = (await request.json()) as { url: string; groupId: string }
          enqueued.push(body.url)
          return HttpResponse.json({
            importId: `imp-${enqueued.length}`,
            cached: false,
          })
        }),
      )

      renderPage(
        '/share-target?text=' +
          encodeURIComponent('https://fb.com/x\nhttps://ig.com/y'),
      )
      await waitFor(() =>
        expect(screen.getAllByTestId('share-picker-card')).toHaveLength(2),
      )
      const btn = screen.getByRole('button', { name: /Alle importieren \(2\)/i })
      await user.click(btn)

      await waitFor(() =>
        expect(screen.getByTestId('import-list-page')).toBeInTheDocument(),
      )
      expect(enqueued).toEqual(['https://fb.com/x', 'https://ig.com/y'])
    })

    it('rejects >10 URLs with a German error and no redirect', async () => {
      signIn()
      const urls = Array.from(
        { length: 11 },
        (_, i) => `https://a.example/${i}`,
      )
      renderPage(
        '/share-target?text=' + encodeURIComponent(urls.join('\n')),
      )
      // Stays on /share-target — no picker, no redirect.
      const loc = screen.getByTestId('location')
      expect(loc.getAttribute('data-pathname')).toBe('/share-target')
      expect(
        screen.getByText(
          /Maximal 10 Links auf einmal — bitte auswählen/i,
        ),
      ).toBeInTheDocument()
    })

    // SHARE-2 /security — the batch-import button must never fire
    // more than MAX_SHARED_URLS (10) POSTs. At exactly 10 URLs the
    // picker renders and "Alle importieren (10)" queues exactly 10
    // jobs. This is the backstop against a hostile payload dripping
    // into Hangfire via the enqueue endpoint.
    it('"Alle importieren (10)" fires exactly 10 POSTs at the cap', async () => {
      signIn()
      const user = userEvent.setup()
      const urls = Array.from(
        { length: 10 },
        (_, i) => `https://a.example/${i}`,
      )
      const enqueued: string[] = []
      server.use(
        http.get('/api/groups', () =>
          HttpResponse.json<GroupSummary[]>([groupSummary({})]),
        ),
        http.post('/api/recipes/import/url', async ({ request }) => {
          const body = (await request.json()) as { url: string; groupId: string }
          enqueued.push(body.url)
          return HttpResponse.json({
            importId: `imp-${enqueued.length}`,
            cached: false,
          })
        }),
      )
      renderPage(
        '/share-target?text=' + encodeURIComponent(urls.join('\n')),
      )
      await waitFor(() =>
        expect(screen.getAllByTestId('share-picker-card')).toHaveLength(10),
      )
      await user.click(
        screen.getByRole('button', { name: /Alle importieren \(10\)/i }),
      )
      await waitFor(() =>
        expect(screen.getByTestId('import-list-page')).toBeInTheDocument(),
      )
      expect(enqueued).toHaveLength(10)
    })
  })
})
