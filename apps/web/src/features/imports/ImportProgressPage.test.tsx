import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { ImportProgressPage, progressLabel } from './ImportProgressPage'
import { rememberImportGroup, forgetImportGroup } from './importGroupMemo'

function LocationProbe() {
  const loc = useLocation()
  return (
    <div data-testid="location">
      {loc.pathname}
      {loc.search}
    </div>
  )
}

function renderProgress(opts?: { initialState?: { groupId?: string }; importId?: string }) {
  const importId = opts?.importId ?? 'imp-1'
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter
          initialEntries={[
            {
              pathname: `/rezepte/import/${importId}`,
              state: opts?.initialState ?? null,
            },
          ]}
        >
          <LocationProbe />
          <Routes>
            <Route path="/rezepte/import/:importId" element={children} />
            <Route
              path="/groups/:groupId/recipes/new"
              element={<div data-testid="recipe-form">form</div>}
            />
            <Route path="/groups" element={<div data-testid="groups">groups</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    )
  }
  return render(<ImportProgressPage />, { wrapper: Wrapper })
}

describe('progressLabel (pure helper)', () => {
  it('returns "Warteschlange …" for queued status regardless of progress', () => {
    expect(progressLabel('queued', 0)).toMatch(/warteschlange/i)
    expect(progressLabel('queued', 50)).toMatch(/warteschlange/i)
  })

  it('uses "Video wird geladen …" at or below 30', () => {
    expect(progressLabel('running', 0)).toMatch(/video wird geladen/i)
    expect(progressLabel('running', 30)).toMatch(/video wird geladen/i)
  })

  it('uses "Transkribieren …" between 31 and 60', () => {
    expect(progressLabel('running', 31)).toMatch(/transkribieren/i)
    expect(progressLabel('running', 60)).toMatch(/transkribieren/i)
  })

  it('uses "Rezept strukturieren …" between 61 and 90', () => {
    expect(progressLabel('running', 61)).toMatch(/rezept strukturieren/i)
    expect(progressLabel('running', 90)).toMatch(/rezept strukturieren/i)
  })

  it('uses "Abschluss …" above 90', () => {
    expect(progressLabel('running', 91)).toMatch(/abschluss/i)
    expect(progressLabel('running', 100)).toMatch(/abschluss/i)
  })
})

describe('<ImportProgressPage />', () => {
  beforeEach(() => {
    useAuthStore.getState().setSession('tok', {
      id: 'u1',
      email: 'u1@ex.com',
      displayName: 'U',
      role: 'User',
    })
    // Clean the memo between tests.
    forgetImportGroup('imp-1')
    forgetImportGroup('imp-err')
    forgetImportGroup('imp-done')
  })
  afterEach(() => {
    server.resetHandlers()
    useAuthStore.getState().clear()
  })

  it('renders the progress bar + step label based on the running status', async () => {
    server.use(
      http.get('/api/imports/imp-1', () =>
        HttpResponse.json({
          id: 'imp-1',
          source: 'Url',
          status: 'Running',
          progress: 45,
          sourceUrl: 'https://example.com',
          result: null,
          error: null,
          createdAt: '2026-04-18T00:00:00Z',
          completedAt: null,
        }),
      ),
    )

    renderProgress({ initialState: { groupId: 'g1' } })

    const bar = await screen.findByRole('progressbar', { name: /import-fortschritt/i })
    await waitFor(() => expect(bar).toHaveAttribute('aria-valuenow', '45'))
    expect(await screen.findByText(/transkribieren/i)).toBeInTheDocument()
    expect(screen.getByText(/45%/)).toBeInTheDocument()
  })

  it('navigates to /groups/:groupId/recipes/new?importId=… when status becomes done (groupId from location state)', async () => {
    server.use(
      http.get('/api/imports/imp-done', () =>
        HttpResponse.json({
          id: 'imp-done',
          source: 'Url',
          status: 'Done',
          progress: 100,
          sourceUrl: 'https://example.com',
          result: JSON.stringify({
            recipe: {
              title: 'T',
              description: null,
              servings: null,
              difficulty: null,
              prep_minutes: null,
              cook_minutes: null,
              ingredients: [],
              steps: [],
              tags: [],
              source_url: 'https://example.com',
              thumbnail_url: null,
            },
            confidence: { overall: 'high', notes: [] },
          }),
          error: null,
          createdAt: '2026-04-18T00:00:00Z',
          completedAt: '2026-04-18T00:00:05Z',
        }),
      ),
    )

    renderProgress({
      importId: 'imp-done',
      initialState: { groupId: 'g1' },
    })

    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(
        '/groups/g1/recipes/new?importId=imp-done',
      ),
    )
  })

  it('recovers groupId from sessionStorage when location state is missing', async () => {
    rememberImportGroup('imp-done', 'g-from-memo')

    server.use(
      http.get('/api/imports/imp-done', () =>
        HttpResponse.json({
          id: 'imp-done',
          source: 'Url',
          status: 'Done',
          progress: 100,
          sourceUrl: 'https://example.com',
          result: JSON.stringify({
            recipe: {
              title: 'T',
              description: null,
              servings: null,
              difficulty: null,
              prep_minutes: null,
              cook_minutes: null,
              ingredients: [],
              steps: [],
              tags: [],
              source_url: 'https://example.com',
              thumbnail_url: null,
            },
            confidence: { overall: 'high', notes: [] },
          }),
          error: null,
          createdAt: '2026-04-18T00:00:00Z',
          completedAt: '2026-04-18T00:00:05Z',
        }),
      ),
    )

    renderProgress({ importId: 'imp-done' })

    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(
        '/groups/g-from-memo/recipes/new?importId=imp-done',
      ),
    )
  })

  it('renders the error message + "Manuell anlegen" CTA when status=error', async () => {
    server.use(
      http.get('/api/imports/imp-err', () =>
        HttpResponse.json({
          id: 'imp-err',
          source: 'Url',
          status: 'Error',
          progress: 35,
          sourceUrl: 'https://example.com',
          result: null,
          error: 'Video ist privat oder nicht verfügbar.',
          createdAt: '2026-04-18T00:00:00Z',
          completedAt: '2026-04-18T00:00:05Z',
        }),
      ),
    )

    renderProgress({ importId: 'imp-err', initialState: { groupId: 'g1' } })

    await waitFor(() => {
      const alert = screen.getByRole('alert')
      expect(alert).toHaveTextContent(/import fehlgeschlagen/i)
      expect(alert).toHaveTextContent(/privat oder nicht verfügbar/i)
    })
    const manualLink = screen.getByRole('link', { name: /manuell anlegen/i })
    expect(manualLink).toHaveAttribute('href', '/groups/g1/recipes/new')
  })

  it('falls back to /groups when status=error and no groupId is known', async () => {
    server.use(
      http.get('/api/imports/imp-err', () =>
        HttpResponse.json({
          id: 'imp-err',
          source: 'Url',
          status: 'Error',
          progress: 10,
          sourceUrl: 'https://example.com',
          result: null,
          error: 'Import fehlgeschlagen.',
          createdAt: '2026-04-18T00:00:00Z',
          completedAt: '2026-04-18T00:00:05Z',
        }),
      ),
    )

    renderProgress({ importId: 'imp-err' })
    const manualLink = await screen.findByRole('link', { name: /manuell anlegen/i })
    expect(manualLink).toHaveAttribute('href', '/groups')
  })
})
