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
import { ImportUrlPage } from './ImportUrlPage'
import { recallImportGroup, forgetImportGroup } from './importGroupMemo'

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

/**
 * Probe component that surfaces the current pathname so tests can assert
 * navigation without coupling to react-router internals.
 */
function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="location">{loc.pathname}</div>
}

function renderPage(opts?: { initialEntry?: string }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  })
  const entry = opts?.initialEntry ?? '/rezepte/import/url'
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[entry]}>
          <LocationProbe />
          <Routes>
            <Route path="/rezepte/import/url" element={children} />
            <Route
              path="/rezepte/import/:importId"
              element={<div data-testid="progress-page">progress</div>}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    )
  }
  return render(<ImportUrlPage />, { wrapper: Wrapper })
}

describe('<ImportUrlPage />', () => {
  beforeEach(() => {
    useAuthStore.getState().setSession('tok', {
      id: 'u1',
      email: 'u1@ex.com',
      displayName: 'U',
      role: 'User',
    })
  })
  afterEach(() => {
    server.resetHandlers()
    useAuthStore.getState().clear()
  })

  it('renders the headline, url field (autofocused), and submit button', async () => {
    server.use(
      http.get('/api/groups', () => HttpResponse.json<GroupSummary[]>([])),
    )
    renderPage()
    expect(
      screen.getByRole('heading', { name: /Rezept aus Video importieren/i }),
    ).toBeInTheDocument()
    const input = screen.getByLabelText(/Video- oder Blog-URL/i)
    expect(input).toBeInTheDocument()
    // jsdom respects autoFocus via the ref effect — assert the focus
    // landed on the URL input.
    await waitFor(() => expect(document.activeElement).toBe(input))
    expect(
      screen.getByRole('button', { name: /Rezept importieren/i }),
    ).toBeDisabled()
  })

  it('rejects a non-http scheme with a German error and no API call', async () => {
    const user = userEvent.setup()
    let posted = false
    server.use(
      http.get('/api/groups', () =>
        HttpResponse.json<GroupSummary[]>([groupSummary({})]),
      ),
      http.post('/api/recipes/import/url', () => {
        posted = true
        return HttpResponse.json({ importId: 'x' }, { status: 202 })
      }),
    )
    renderPage()
    await user.type(screen.getByLabelText(/Video- oder Blog-URL/i), 'ftp://example.com/x')
    await user.click(screen.getByRole('button', { name: /Rezept importieren/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /muss absolut sein und mit http/i,
    )
    expect(posted).toBe(false)
  })

  it('with 1 group: skips picker, POSTs with that groupId, navigates to the progress route', async () => {
    const user = userEvent.setup()
    let capturedBody: { url: string; groupId: string } | null = null
    server.use(
      http.get('/api/groups', () =>
        HttpResponse.json<GroupSummary[]>([
          groupSummary({ id: 'only', isPrivateCollection: true, memberCount: 1 }),
        ]),
      ),
      http.post('/api/recipes/import/url', async ({ request }) => {
        capturedBody = (await request.json()) as { url: string; groupId: string }
        return HttpResponse.json({ importId: 'imp-42' }, { status: 202 })
      }),
    )
    renderPage()
    await user.type(
      screen.getByLabelText(/Video- oder Blog-URL/i),
      'https://example.com/r',
    )
    await user.click(screen.getByRole('button', { name: /Rezept importieren/i }))

    await waitFor(() => expect(capturedBody).not.toBeNull())
    expect(capturedBody!.groupId).toBe('only')
    expect(capturedBody!.url).toBe('https://example.com/r')
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/rezepte/import/imp-42'),
    )
  })

  it('with >1 groups: opens the GroupPickerDialog, POSTs with the picked group on selection', async () => {
    const user = userEvent.setup()
    let capturedBody: { url: string; groupId: string } | null = null
    server.use(
      http.get('/api/groups', () =>
        HttpResponse.json<GroupSummary[]>([
          groupSummary({ id: 'ga', name: 'Alpha' }),
          groupSummary({ id: 'gb', name: 'Beta' }),
        ]),
      ),
      http.post('/api/recipes/import/url', async ({ request }) => {
        capturedBody = (await request.json()) as { url: string; groupId: string }
        return HttpResponse.json({ importId: 'imp-77' }, { status: 202 })
      }),
    )
    renderPage()
    // Wait for groups so the branch is correct when submit fires.
    await screen.findByRole('heading', { name: /Rezept aus Video importieren/i })

    await user.type(
      screen.getByLabelText(/Video- oder Blog-URL/i),
      'https://example.com/r',
    )
    await user.click(screen.getByRole('button', { name: /Rezept importieren/i }))

    // The picker dialog opens.
    const pickerHeading = await screen.findByText(/in welcher gruppe/i)
    expect(pickerHeading).toBeInTheDocument()
    // Pick Beta.
    await user.click(screen.getByRole('button', { name: /Beta/ }))

    await waitFor(() => expect(capturedBody).not.toBeNull())
    expect(capturedBody!.groupId).toBe('gb')
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/rezepte/import/imp-77'),
    )
  })

  it('with 0 groups: offers CreateGroupDialog and does NOT POST', async () => {
    const user = userEvent.setup()
    let posted = false
    server.use(
      http.get('/api/groups', () => HttpResponse.json<GroupSummary[]>([])),
      http.post('/api/recipes/import/url', () => {
        posted = true
        return HttpResponse.json({ importId: 'x' }, { status: 202 })
      }),
    )
    renderPage()
    await user.type(
      screen.getByLabelText(/Video- oder Blog-URL/i),
      'https://example.com/r',
    )
    await user.click(screen.getByRole('button', { name: /Rezept importieren/i }))
    expect(await screen.findByText(/Gruppe erstellen/i)).toBeInTheDocument()
    expect(posted).toBe(false)
  })

  it('remembers the groupId in sessionStorage keyed by importId so reload still routes on done', async () => {
    const user = userEvent.setup()
    forgetImportGroup('imp-memo')
    server.use(
      http.get('/api/groups', () =>
        HttpResponse.json<GroupSummary[]>([groupSummary({ id: 'g-memo' })]),
      ),
      http.post('/api/recipes/import/url', () =>
        HttpResponse.json({ importId: 'imp-memo' }, { status: 202 }),
      ),
    )
    renderPage()
    await user.type(
      screen.getByLabelText(/Video- oder Blog-URL/i),
      'https://example.com/r',
    )
    await user.click(screen.getByRole('button', { name: /Rezept importieren/i }))
    await waitFor(() => expect(recallImportGroup('imp-memo')).toBe('g-memo'))
  })

  // PV3 security regression: a crafted `/rezepte/import/url?url=evil`
  // link could otherwise combine with the autofocused input + a single
  // Enter keystroke to POST the attacker URL under the victim's
  // session. We render a warning banner AND drop autofocus when `?url`
  // prefills the input, so submitting requires an explicit click.
  it('?url= prefill: renders warning banner and does NOT autofocus the input', async () => {
    server.use(
      http.get('/api/groups', () =>
        HttpResponse.json<GroupSummary[]>([groupSummary({})]),
      ),
    )
    renderPage({
      initialEntry:
        '/rezepte/import/url?url=' +
        encodeURIComponent('https://evil.example/x'),
    })

    const input = screen.getByLabelText(/Video- oder Blog-URL/i)
    expect((input as HTMLInputElement).value).toBe('https://evil.example/x')

    // Banner is visible with the German copy reviewed in the plan.
    expect(
      await screen.findByTestId('import-url-prefill-warning'),
    ).toHaveTextContent(/stammt aus einem Link/i)

    // Critical: the URL input must NOT be auto-focused in this flow —
    // otherwise Enter alone would submit the attacker URL.
    expect(document.activeElement).not.toBe(input)
  })

  // BUG-009 regression: at 375px width the page must not horizontally
  // overflow. We assert the structural classes that prevent it — the
  // <main> caps at max-w-2xl + clips overflow, the URL <input> has
  // max-w-full + min-w-0 so a pasted-1k-char URL cannot push the form
  // wider than its parent, and the inline error is wrapped with
  // break-all so a long URL inside an error message wraps instead of
  // pushing the layout.
  it('BUG-009: main container clips overflow + url input is max-w-full', async () => {
    server.use(
      http.get('/api/groups', () => HttpResponse.json<GroupSummary[]>([])),
    )
    renderPage()
    const heading = await screen.findByRole('heading', {
      name: /Rezept aus Video importieren/i,
    })
    const main = heading.closest('main')
    expect(main).not.toBeNull()
    expect(main!.className).toMatch(/max-w-2xl/)
    expect(main!.className).toMatch(/overflow-hidden/)
    // No w-screen / 100vw escapes inside the page subtree.
    expect(main!.innerHTML).not.toMatch(/w-screen/)
    expect(main!.innerHTML).not.toMatch(/100vw/)

    const input = screen.getByLabelText(/Video- oder Blog-URL/i)
    expect(input.className).toMatch(/w-full/)
    expect(input.className).toMatch(/max-w-full/)
    expect(input.className).toMatch(/min-w-0/)
  })

  it('BUG-009: long error text uses break-all so it wraps inside the viewport', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('/api/groups', () =>
        HttpResponse.json<GroupSummary[]>([groupSummary({ id: 'only' })]),
      ),
      http.post('/api/recipes/import/url', () =>
        HttpResponse.json(
          {
            code: 'invalid_url',
            message:
              'Die URL https://example.com/very/very/long/path/that/would/otherwise/overflow/the/viewport/on/mobile?query=' +
              'a'.repeat(200) +
              ' ist nicht erlaubt.',
          },
          { status: 400 },
        ),
      ),
    )
    renderPage()
    await user.type(
      screen.getByLabelText(/Video- oder Blog-URL/i),
      'https://example.com/r',
    )
    await user.click(screen.getByRole('button', { name: /Rezept importieren/i }))
    const alert = await screen.findByRole('alert')
    expect(alert.className).toMatch(/break-all/)
  })

  // BUG-013 — URL-import cache-hit UX. On `cached: true` we stop the
  // auto-redirect, render a blue banner with two CTAs, and support both
  // "Zum bestehenden Rezept" (navigate to the cached import's progress
  // page) and "Neu extrahieren" (re-POST with `force: true`, skip cache).

  it('BUG-013 cache-hit: renders banner with both CTAs and does NOT auto-navigate', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('/api/groups', () =>
        HttpResponse.json<GroupSummary[]>([groupSummary({ id: 'only' })]),
      ),
      http.post('/api/recipes/import/url', () =>
        HttpResponse.json(
          { importId: 'imp-cached-1', cached: true },
          { status: 202 },
        ),
      ),
    )
    renderPage()
    await user.type(
      screen.getByLabelText(/Video- oder Blog-URL/i),
      'https://example.com/r',
    )
    await user.click(screen.getByRole('button', { name: /Rezept importieren/i }))

    // Banner with both CTAs.
    expect(
      await screen.findByTestId('import-url-cache-banner'),
    ).toHaveTextContent(/bereits importiert/i)
    expect(
      screen.getByRole('button', { name: /Zum bestehenden Rezept/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /Neu extrahieren/i }),
    ).toBeInTheDocument()

    // No auto-navigate — we stay on the URL-import page so the user
    // actively picks a branch.
    expect(screen.getByTestId('location')).toHaveTextContent('/rezepte/import/url')
  })

  it('BUG-013 cache-hit: "Zum bestehenden Rezept" navigates to the cached progress page', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('/api/groups', () =>
        HttpResponse.json<GroupSummary[]>([groupSummary({ id: 'only' })]),
      ),
      http.post('/api/recipes/import/url', () =>
        HttpResponse.json(
          { importId: 'imp-cached-2', cached: true },
          { status: 202 },
        ),
      ),
    )
    renderPage()
    await user.type(
      screen.getByLabelText(/Video- oder Blog-URL/i),
      'https://example.com/r',
    )
    await user.click(screen.getByRole('button', { name: /Rezept importieren/i }))

    await screen.findByTestId('import-url-cache-banner')
    await user.click(screen.getByRole('button', { name: /Zum bestehenden Rezept/i }))

    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(
        '/rezepte/import/imp-cached-2',
      ),
    )
  })

  it('BUG-013 cache-hit: "Neu extrahieren" re-POSTs with force=true and navigates fresh', async () => {
    const user = userEvent.setup()
    const posts: Array<{ url: string; groupId: string; force?: boolean }> = []
    server.use(
      http.get('/api/groups', () =>
        HttpResponse.json<GroupSummary[]>([groupSummary({ id: 'only' })]),
      ),
      http.post('/api/recipes/import/url', async ({ request }) => {
        const body = (await request.json()) as {
          url: string
          groupId: string
          force?: boolean
        }
        posts.push(body)
        if (body.force === true) {
          // Fresh enqueue — no `cached` flag.
          return HttpResponse.json({ importId: 'imp-fresh' }, { status: 202 })
        }
        return HttpResponse.json(
          { importId: 'imp-cached-3', cached: true },
          { status: 202 },
        )
      }),
    )
    renderPage()
    await user.type(
      screen.getByLabelText(/Video- oder Blog-URL/i),
      'https://example.com/r',
    )
    await user.click(screen.getByRole('button', { name: /Rezept importieren/i }))

    await screen.findByTestId('import-url-cache-banner')
    await user.click(screen.getByRole('button', { name: /Neu extrahieren/i }))

    await waitFor(() => expect(posts.length).toBe(2))
    expect(posts[0]!.force ?? false).toBe(false)
    expect(posts[1]!.force).toBe(true)
    // After the force-refresh lands we navigate to the fresh import id.
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(
        '/rezepte/import/imp-fresh',
      ),
    )
  })

  // REL-3f — backend error-codes route through `classifyMutationError`
  // → localised `errors.json` copy. The test also asserts that the raw
  // English Dev-Message never surfaces verbatim.
  it('surfaces a server 400 error via errors:<code> localisation (no navigation)', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('/api/groups', () =>
        HttpResponse.json<GroupSummary[]>([groupSummary({ id: 'only' })]),
      ),
      http.post('/api/recipes/import/url', () =>
        HttpResponse.json(
          {
            code: 'invalid_url',
            message: 'URL is not allowed.',
            status: 400,
          },
          { status: 400 },
        ),
      ),
    )
    renderPage()
    await user.type(
      screen.getByLabelText(/Video- oder Blog-URL/i),
      'https://example.com/r',
    )
    await user.click(screen.getByRole('button', { name: /Rezept importieren/i }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/URL ist ungültig\./)
    expect(alert).not.toHaveTextContent(/URL is not allowed/)
    expect(screen.getByTestId('location')).toHaveTextContent('/rezepte/import/url')
  })

  // REL-3f — 5xx responses must never leak raw server messages
  // (stack traces, SQL fragments) into the UI.
  it('surfaces a generic German fallback on 5xx without leaking raw message', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('/api/groups', () =>
        HttpResponse.json<GroupSummary[]>([groupSummary({ id: 'only' })]),
      ),
      http.post('/api/recipes/import/url', () =>
        HttpResponse.json(
          {
            code: 'internal_error',
            message: 'yt-dlp crashed: TypeError at extractors.py:42',
            status: 500,
          },
          { status: 500 },
        ),
      ),
    )
    renderPage()
    await user.type(
      screen.getByLabelText(/Video- oder Blog-URL/i),
      'https://example.com/r',
    )
    await user.click(screen.getByRole('button', { name: /Rezept importieren/i }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/Unbekannter Fehler/)
    expect(alert).not.toHaveTextContent(/yt-dlp crashed/)
  })

  describe('BUG-025 regression: input font-size ≥ 16px', () => {
    it('URL input className includes `text-base` (prevents iOS auto-zoom)', async () => {
      server.use(
        http.get('/api/groups', () => HttpResponse.json<GroupSummary[]>([])),
      )
      renderPage()
      const input = screen.getByLabelText(/Video- oder Blog-URL/i)
      expect(input.className).toMatch(/\btext-base\b/)
    })
  })
})
