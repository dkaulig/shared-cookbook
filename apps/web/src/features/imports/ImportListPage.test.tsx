import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { ImportListPage } from './ImportListPage'
import { formatRelativeTime } from './relativeTime'

/**
 * BUG-010 — regression tests for the `/rezepte/import` dashboard.
 *
 * Covers:
 *   - Loading spinner → list render path with all four status chips.
 *   - Empty state CTAs.
 *   - Running row shows a progress-bar (Queued/Done/Error do NOT).
 *   - Click on Done navigates to the recipe-form prefill target.
 *   - Click on Queued/Running navigates to the shared ImportProgressPage.
 *   - Relative-time helper emits German "vor … Minuten" strings.
 */

function LocationProbe() {
  const loc = useLocation()
  return (
    <div data-testid="location">
      {loc.pathname}
      {loc.search}
    </div>
  )
}

function renderList() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/rezepte/import']}>
          <LocationProbe />
          <Routes>
            <Route path="/rezepte/import" element={children} />
            <Route
              path="/rezepte/import/:importId"
              element={<div data-testid="progress-page">progress</div>}
            />
            <Route
              path="/rezepte/import/url"
              element={<div data-testid="url-page">url</div>}
            />
            <Route
              path="/rezepte/import/photos"
              element={<div data-testid="photos-page">photos</div>}
            />
            <Route path="/chat" element={<div data-testid="chat-page">chat</div>} />
            <Route
              path="/groups/:groupId/recipes/new"
              element={<div data-testid="recipe-form">form</div>}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    )
  }
  return render(<ImportListPage />, { wrapper: Wrapper })
}

/**
 * Helper that shapes an `ImportSummary` wire row with sensible defaults.
 * The endpoint returns TitleCase `status`/`source` + snake-case `phase`
 * — matches the .NET `ImportSummary` record.
 */
function wire(
  overrides: Partial<{
    id: string
    groupId: string
    source: string
    status: string
    progress: number
    phase: string
    progressLabel: string | null
    sourceUrl: string | null
    createdAt: string
    completedAt: string | null
    error: string | null
  }> = {},
) {
  return {
    id: 'imp-list-1',
    groupId: 'g-list-1',
    source: 'Url',
    status: 'Queued',
    progress: 0,
    phase: 'queued',
    progressLabel: null,
    sourceUrl: 'https://example.com/rezept-url',
    createdAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    ...overrides,
  }
}

describe('<ImportListPage />', () => {
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

  it('renders a heading + the three create-CTAs', async () => {
    server.use(http.get('/api/imports', () => HttpResponse.json([])))
    renderList()

    expect(
      screen.getByRole('heading', { name: /Meine Imports/i }),
    ).toBeInTheDocument()
    expect(screen.getByTestId('import-cta-url')).toHaveAttribute(
      'href',
      '/rezepte/import/url',
    )
    expect(screen.getByTestId('import-cta-photos')).toHaveAttribute(
      'href',
      '/rezepte/import/photos',
    )
    expect(screen.getByTestId('import-cta-chat')).toHaveAttribute(
      'href',
      '/chat',
    )
  })

  it('shows the empty state when the list is empty', async () => {
    server.use(http.get('/api/imports', () => HttpResponse.json([])))
    renderList()

    await waitFor(() =>
      expect(screen.getByTestId('import-list-empty')).toBeInTheDocument(),
    )
    expect(
      screen.getByText(/Noch keine Imports/i),
    ).toBeInTheDocument()
  })

  it('renders every non-terminal row with a progress-bar and all status chips', async () => {
    server.use(
      http.get('/api/imports', () =>
        HttpResponse.json([
          wire({
            id: 'imp-running',
            status: 'Running',
            progress: 42,
            phase: 'transcribing',
            progressLabel: 'Audio wird transkribiert',
          }),
          wire({
            id: 'imp-queued',
            status: 'Queued',
            progress: 5,
            phase: 'queued',
          }),
          wire({
            id: 'imp-done',
            status: 'Done',
            progress: 100,
            phase: 'done',
            completedAt: new Date().toISOString(),
          }),
          wire({
            id: 'imp-error',
            status: 'Error',
            progress: 30,
            phase: 'error',
            error: 'Video privat',
          }),
        ]),
      ),
    )
    renderList()

    await waitFor(() =>
      expect(screen.getByTestId('import-row-imp-running')).toBeInTheDocument(),
    )

    expect(
      screen.getByTestId('import-row-progress-imp-running'),
    ).toBeInTheDocument()
    // Queued rows are non-terminal too — they also get a bar.
    expect(
      screen.getByTestId('import-row-progress-imp-queued'),
    ).toBeInTheDocument()
    // Done + Error are terminal — no bar.
    expect(
      screen.queryByTestId('import-row-progress-imp-done'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByTestId('import-row-progress-imp-error'),
    ).not.toBeInTheDocument()

    // All four status chips render with the right data-testid attribute.
    expect(screen.getByTestId('import-status-chip-running')).toBeInTheDocument()
    expect(screen.getByTestId('import-status-chip-queued')).toBeInTheDocument()
    expect(screen.getByTestId('import-status-chip-done')).toBeInTheDocument()
    expect(screen.getByTestId('import-status-chip-error')).toBeInTheDocument()
  })

  it('navigates a Done row straight to the recipe-form prefill target', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('/api/imports', () =>
        HttpResponse.json([
          wire({
            id: 'imp-done-1',
            groupId: 'g-42',
            status: 'Done',
            progress: 100,
            phase: 'done',
            completedAt: new Date().toISOString(),
          }),
        ]),
      ),
    )
    renderList()
    const row = await screen.findByTestId('import-row-imp-done-1')
    await user.click(row)

    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(
        '/groups/g-42/recipes/new?importId=imp-done-1',
      ),
    )
  })

  it('navigates a Running row to /rezepte/import/:id (shared progress page)', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('/api/imports', () =>
        HttpResponse.json([
          wire({
            id: 'imp-run',
            groupId: 'g-99',
            status: 'Running',
            progress: 50,
            phase: 'transcribing',
          }),
        ]),
      ),
    )
    renderList()
    const row = await screen.findByTestId('import-row-imp-run')
    await user.click(row)

    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(
        '/rezepte/import/imp-run',
      ),
    )
  })

  it('renders the backend error state when the list fetch fails', async () => {
    server.use(
      http.get('/api/imports', () =>
        HttpResponse.json(
          { code: 'boom', message: 'Deine Imports konnten nicht geladen werden.' },
          { status: 500 },
        ),
      ),
    )
    renderList()

    await waitFor(() =>
      expect(screen.getByTestId('import-list-error')).toBeInTheDocument(),
    )
  })
})

describe('formatRelativeTime (pure helper)', () => {
  const now = new Date('2026-04-19T12:00:00Z')

  it('formats the recent past in German ("vor 5 Minuten")', () => {
    const fiveAgo = new Date(now.getTime() - 5 * 60 * 1000).toISOString()
    const out = formatRelativeTime(fiveAgo, now)
    expect(out.toLowerCase()).toMatch(/vor\s5\sminuten/)
  })

  it('uses the hour bucket beyond 60 minutes', () => {
    const twoHours = new Date(now.getTime() - 2 * 3600 * 1000).toISOString()
    const out = formatRelativeTime(twoHours, now)
    expect(out.toLowerCase()).toMatch(/vor\s2\sstunden/)
  })

  it('returns "" for a malformed timestamp instead of throwing', () => {
    expect(formatRelativeTime('not-a-date', now)).toBe('')
  })
})
