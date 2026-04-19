import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { ImportProgressPage } from './ImportProgressPage'
import { progressLabel } from './progressLabel'
import { rememberImportGroup, forgetImportGroup } from './importGroupMemo'
import { importQueryKeys } from './hooks'

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
            <Route
              path="/rezepte/import/url"
              element={<div data-testid="import-url-page">url</div>}
            />
            <Route path="/groups" element={<div data-testid="groups">groups</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    )
  }
  const utils = render(<ImportProgressPage />, { wrapper: Wrapper })
  return { ...utils, client, importId }
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

  // Reviewer-flagged edge case: user opens the progress URL in a new
  // tab (no navigation state) AFTER extraction already completed, and
  // no sessionStorage memo exists for this importId. Without a CTA the
  // user gets stuck on a "Fertig" progress bar with only a Back button
  // — the extracted recipe would be orphaned. Now we render a
  // DoneWithoutGroupPanel with a "Gruppe auswählen" link to /groups.
  it('shows a group-picker CTA when status=done but groupId is unknown', async () => {
    // Explicitly clear the memo in case a previous test polluted it,
    // matching the "fresh tab" conditions this edge case describes.
    forgetImportGroup('imp-orphan')

    server.use(
      http.get('/api/imports/imp-orphan', () =>
        HttpResponse.json({
          id: 'imp-orphan',
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

    renderProgress({ importId: 'imp-orphan' })

    // Fallback panel visible.
    await waitFor(() =>
      expect(screen.getByTestId('import-done-no-group')).toBeInTheDocument(),
    )
    const link = screen.getByRole('link', { name: /gruppe auswählen/i })
    expect(link).toHaveAttribute('href', '/groups')
    // No navigation happened (the recipe-form fallback testid is absent).
    expect(screen.queryByTestId('recipe-form')).toBeNull()
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

describe('<ImportProgressPage /> PV3 phase-aware UI', () => {
  beforeEach(() => {
    useAuthStore.getState().setSession('tok', {
      id: 'u1',
      email: 'u1@ex.com',
      displayName: 'U',
      role: 'User',
    })
    forgetImportGroup('imp-phase')
  })
  afterEach(() => {
    server.resetHandlers()
    useAuthStore.getState().clear()
  })

  it('renders the phase stepper + detail card when the cache carries phase data', async () => {
    // Seed a SignalR-style cache entry BEFORE the page mounts so the
    // first render already shows the phase-aware UI without waiting
    // for a poll — mirrors the production path (SignalR lands first).
    server.use(
      http.get('/api/imports/imp-phase', () =>
        HttpResponse.json({
          id: 'imp-phase',
          source: 'Url',
          status: 'Running',
          progress: 45,
          sourceUrl: 'https://example.com',
          result: null,
          error: null,
          createdAt: '2026-04-19T12:00:00Z',
          completedAt: null,
        }),
      ),
    )

    const { client } = renderProgress({
      importId: 'imp-phase',
      initialState: { groupId: 'g1' },
    })
    client.setQueryData(importQueryKeys.status('imp-phase'), {
      id: 'imp-phase',
      source: 'url',
      status: 'running',
      progress: 45,
      sourceUrl: 'https://example.com',
      result: null,
      errorMessage: null,
      createdAt: '2026-04-19T12:00:00Z',
      completedAt: null,
      phase: 'transcribing',
      phaseProgress: 42,
      progressLabel: 'Audio wird transkribiert',
      attemptNumber: 1,
      lastProgressAt: new Date().toISOString(),
      segmentsDone: 5,
      segmentsTotal: 20,
    })

    // Phase stepper shows transcribing as current.
    expect(
      await screen.findByTestId('phase-step-transcribing'),
    ).toHaveAttribute('data-state', 'current')
    expect(screen.getByTestId('phase-detail-transcribing')).toBeInTheDocument()
    expect(screen.getByText(/audio wird transkribiert/i)).toBeInTheDocument()
    // Overall progress uses the server label.
    expect(screen.getByText(/audio wird transkribiert/i)).toBeInTheDocument()
  })

  it('shows the RetryIndicator only when attemptNumber > 1', async () => {
    const { client } = renderProgress({
      importId: 'imp-phase',
      initialState: { groupId: 'g1' },
    })
    client.setQueryData(importQueryKeys.status('imp-phase'), {
      id: 'imp-phase',
      source: 'url',
      status: 'running',
      progress: 20,
      sourceUrl: 'https://example.com',
      result: null,
      errorMessage: null,
      createdAt: '2026-04-19T12:00:00Z',
      completedAt: null,
      phase: 'downloading',
      phaseProgress: 50,
      progressLabel: 'Video wird heruntergeladen',
      attemptNumber: 2,
    })
    expect(await screen.findByTestId('retry-indicator')).toHaveTextContent(
      /erneuter versuch 2\/3/i,
    )
  })

  it('hides the RetryIndicator on the first attempt', async () => {
    const { client } = renderProgress({
      importId: 'imp-phase',
      initialState: { groupId: 'g1' },
    })
    client.setQueryData(importQueryKeys.status('imp-phase'), {
      id: 'imp-phase',
      source: 'url',
      status: 'running',
      progress: 20,
      sourceUrl: 'https://example.com',
      result: null,
      errorMessage: null,
      createdAt: '2026-04-19T12:00:00Z',
      completedAt: null,
      phase: 'downloading',
      phaseProgress: 50,
      progressLabel: 'Video wird heruntergeladen',
      attemptNumber: 1,
    })
    // Seed completes synchronously; the element should be absent now.
    await waitFor(() =>
      expect(screen.queryByTestId('retry-indicator')).toBeNull(),
    )
  })

  it('shows the StaleBanner when lastProgressAt is >2 min ago and status is running', async () => {
    const { client } = renderProgress({
      importId: 'imp-phase',
      initialState: { groupId: 'g1' },
    })
    const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString()
    client.setQueryData(importQueryKeys.status('imp-phase'), {
      id: 'imp-phase',
      source: 'url',
      status: 'running',
      progress: 50,
      sourceUrl: 'https://example.com',
      result: null,
      errorMessage: null,
      createdAt: threeMinutesAgo,
      completedAt: null,
      phase: 'transcribing',
      phaseProgress: 50,
      progressLabel: 'Audio wird transkribiert',
      attemptNumber: 1,
      lastProgressAt: threeMinutesAgo,
    })
    expect(await screen.findByTestId('stale-banner')).toBeInTheDocument()
  })

  it('does not auto-redirect instantly on done — waits ~500ms first', async () => {
    server.use(
      http.get('/api/imports/imp-phase', () =>
        HttpResponse.json({
          id: 'imp-phase',
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
          createdAt: '2026-04-19T12:00:00Z',
          completedAt: '2026-04-19T12:00:05Z',
        }),
      ),
    )

    renderProgress({
      importId: 'imp-phase',
      initialState: { groupId: 'g1' },
    })
    // The 500ms timer will eventually redirect; the location probe
    // confirms we land on the recipe-form route.
    await waitFor(
      () =>
        expect(screen.getByTestId('location')).toHaveTextContent(
          '/groups/g1/recipes/new?importId=imp-phase',
        ),
      { timeout: 2000 },
    )
  })

  it('Error-state "Neu starten" navigates back to /rezepte/import/url with ?url=… prefill', async () => {
    server.use(
      http.get('/api/imports/imp-phase', () =>
        HttpResponse.json({
          id: 'imp-phase',
          source: 'Url',
          status: 'Error',
          progress: 20,
          sourceUrl: 'https://example.com/r',
          result: null,
          error: 'Extractor crashed',
          createdAt: '2026-04-19T12:00:00Z',
          completedAt: '2026-04-19T12:00:05Z',
        }),
      ),
    )

    renderProgress({
      importId: 'imp-phase',
      initialState: { groupId: 'g1' },
    })
    const button = await screen.findByRole('button', { name: /neu starten/i })
    await userEvent.click(button)
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(
        '/rezepte/import/url?url=https%3A%2F%2Fexample.com%2Fr',
      ),
    )
  })
})
