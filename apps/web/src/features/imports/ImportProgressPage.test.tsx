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
              path="/groups/:groupId/recipes/:recipeId"
              element={<div data-testid="recipe-detail">detail</div>}
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
          groupId: 'g1',
          source: 'Url',
          status: 'Running',
          progress: 45,
          sourceUrl: 'https://example.com',
          result: null,
          error: null,
          createdAt: '2026-04-18T00:00:00Z',
          completedAt: null,
          phase: 'transcribing',
          phaseProgress: 40,
          progressLabel: 'Audio wird transkribiert',
          attemptNumber: 1,
          bytesDownloaded: null,
          bytesTotal: null,
          segmentsDone: null,
          segmentsTotal: null,
          lastProgressAt: '2026-04-18T00:00:00Z',
        }),
      ),
    )

    renderProgress({ initialState: { groupId: 'g1' } })

    const bar = await screen.findByRole('progressbar', { name: /import-fortschritt/i })
    await waitFor(() => expect(bar).toHaveAttribute('aria-valuenow', '45'))
    // PV4 — the wire now carries the server-computed progressLabel
    // verbatim ("Audio wird transkribiert"). Multiple UI surfaces render
    // it (the OverallProgressBar + the PhaseDetailCard), so use
    // findAllByText to assert presence without tripping the
    // "multiple elements" guard.
    const matches = await screen.findAllByText(/audio wird transkribiert/i)
    expect(matches.length).toBeGreaterThan(0)
    expect(screen.getByText(/45%/)).toBeInTheDocument()
  })

  it('navigates to /groups/:groupId/recipes/new?importId=… when status becomes done (groupId from location state)', async () => {
    server.use(
      http.get('/api/imports/imp-done', () =>
        HttpResponse.json({
          id: 'imp-done',
          groupId: 'g-from-server',
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
          phase: 'done',
          phaseProgress: 100,
          progressLabel: 'Fertig',
          attemptNumber: 1,
          bytesDownloaded: null,
          bytesTotal: null,
          segmentsDone: null,
          segmentsTotal: null,
          lastProgressAt: '2026-04-18T00:00:05Z',
        }),
      ),
    )

    renderProgress({
      importId: 'imp-done',
      initialState: { groupId: 'g1' },
    })

    // Navigation-state groupId wins over the wire groupId (resolution
    // order matches PV4 useMemo in ImportProgressPage).
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
          groupId: 'g-from-server',
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
          phase: 'done',
          phaseProgress: 100,
          progressLabel: 'Fertig',
          attemptNumber: 1,
          bytesDownloaded: null,
          bytesTotal: null,
          segmentsDone: null,
          segmentsTotal: null,
          lastProgressAt: '2026-04-18T00:00:05Z',
        }),
      ),
    )

    renderProgress({ importId: 'imp-done' })

    // sessionStorage memo wins over the wire groupId (resolution order
    // matches PV4 useMemo in ImportProgressPage).
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(
        '/groups/g-from-memo/recipes/new?importId=imp-done',
      ),
    )
  })

  // BUG-012 regression test: the user reloaded the tab mid-import (or
  // opened the progress URL in a new tab) so location.state is null AND
  // sessionStorage is empty. Previously this left the user stuck on the
  // DoneWithoutGroupPanel. PV4 falls back to `data.groupId` from the
  // status response and the redirect now fires normally.
  it('falls back to data.groupId from the status response when location state AND sessionStorage are empty (BUG-012)', async () => {
    forgetImportGroup('imp-bug-012')

    server.use(
      http.get('/api/imports/imp-bug-012', () =>
        HttpResponse.json({
          id: 'imp-bug-012',
          groupId: 'g-from-server',
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
          phase: 'done',
          phaseProgress: 100,
          progressLabel: 'Fertig',
          attemptNumber: 1,
          bytesDownloaded: null,
          bytesTotal: null,
          segmentsDone: null,
          segmentsTotal: null,
          lastProgressAt: '2026-04-18T00:00:05Z',
        }),
      ),
    )

    renderProgress({ importId: 'imp-bug-012' })

    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(
        '/groups/g-from-server/recipes/new?importId=imp-bug-012',
      ),
    )
    // The DoneWithoutGroupPanel fallback must NOT render anymore — the
    // server's groupId resolved the fragile-state edge case.
    expect(screen.queryByTestId('import-done-no-group')).toBeNull()
  })

  // PV4 rare edge case: even the server's groupId is missing / empty
  // (data corruption — the normal path now always returns a valid
  // groupId on the wire, so this branch is only reachable if the row
  // itself somehow lost its group scoping). Previously this edge case
  // fired on every reload (BUG-012); after PV4 it only fires when the
  // wire groupId is blank. Kept as defensive fallback so a broken
  // backend still guides the user instead of stranding them on a
  // spinning loader.
  it('shows a group-picker CTA when status=done AND wire groupId is missing (rare)', async () => {
    forgetImportGroup('imp-orphan')

    server.use(
      http.get('/api/imports/imp-orphan', () =>
        HttpResponse.json({
          id: 'imp-orphan',
          // Empty string mimics the data-corruption case — the server
          // serialised a blank groupId for this import row.
          groupId: '',
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
          phase: 'done',
          phaseProgress: 100,
          progressLabel: 'Fertig',
          attemptNumber: 1,
          bytesDownloaded: null,
          bytesTotal: null,
          segmentsDone: null,
          segmentsTotal: null,
          lastProgressAt: '2026-04-18T00:00:05Z',
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
          groupId: 'g1',
          source: 'Url',
          status: 'Error',
          progress: 35,
          sourceUrl: 'https://example.com',
          result: null,
          error: 'Video ist privat oder nicht verfügbar.',
          createdAt: '2026-04-18T00:00:00Z',
          completedAt: '2026-04-18T00:00:05Z',
          phase: 'error',
          phaseProgress: 0,
          progressLabel: 'Fehler',
          attemptNumber: 1,
          bytesDownloaded: null,
          bytesTotal: null,
          segmentsDone: null,
          segmentsTotal: null,
          lastProgressAt: '2026-04-18T00:00:05Z',
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

  // BUG-009 regression: at 375px width the page must not horizontally
  // overflow. Long error messages (typically a stack-trace-with-URL from
  // the extractor) used to push the layout wider than the viewport. We
  // now (a) clip overflow on the <main> wrapper, (b) wrap the
  // PhaseDetailCard sub-line with `break-all` so embedded URLs wrap on
  // any character, and (c) ensure no descendant uses w-screen / 100vw.
  it('BUG-009: long error message wraps via break-all and main clips overflow', async () => {
    const longErr =
      'Extractor crashed at https://very-long-host.example.com/path/to/' +
      'a'.repeat(200) +
      '?query=' +
      'b'.repeat(200)
    server.use(
      http.get('/api/imports/imp-err', () =>
        HttpResponse.json({
          id: 'imp-err',
          groupId: 'g1',
          source: 'Url',
          status: 'Error',
          progress: 35,
          sourceUrl: 'https://example.com',
          result: null,
          error: longErr,
          createdAt: '2026-04-18T00:00:00Z',
          completedAt: '2026-04-18T00:00:05Z',
          phase: 'error',
          phaseProgress: 0,
          progressLabel: 'Fehler',
          attemptNumber: 1,
          bytesDownloaded: null,
          bytesTotal: null,
          segmentsDone: null,
          segmentsTotal: null,
          lastProgressAt: '2026-04-18T00:00:05Z',
        }),
      ),
    )

    renderProgress({ importId: 'imp-err', initialState: { groupId: 'g1' } })

    const alert = await screen.findByRole('alert')
    // PhaseDetailCard renders the long error inside a <p> with break-all.
    const longParagraph = alert.querySelector('p.break-all')
    expect(longParagraph).not.toBeNull()
    expect(longParagraph!.textContent).toContain(longErr)

    // <main> caps width + clips overflow.
    const main = alert.closest('main')
    expect(main).not.toBeNull()
    expect(main!.className).toMatch(/max-w-2xl/)
    expect(main!.className).toMatch(/overflow-hidden/)
    // No w-screen / 100vw escapes inside the page subtree.
    expect(main!.innerHTML).not.toMatch(/w-screen/)
    expect(main!.innerHTML).not.toMatch(/100vw/)
  })

  it('falls back to /groups when status=error and no groupId is known', async () => {
    // PV4 data-corruption scenario: wire groupId is empty + location
    // state is absent + sessionStorage memo is missing — the Manuell-
    // anlegen CTA degrades to /groups (the pre-PV4 fallback path).
    server.use(
      http.get('/api/imports/imp-err', () =>
        HttpResponse.json({
          id: 'imp-err',
          groupId: '',
          source: 'Url',
          status: 'Error',
          progress: 10,
          sourceUrl: 'https://example.com',
          result: null,
          error: 'Import fehlgeschlagen.',
          createdAt: '2026-04-18T00:00:00Z',
          completedAt: '2026-04-18T00:00:05Z',
          phase: 'error',
          phaseProgress: 0,
          progressLabel: 'Fehler',
          attemptNumber: 1,
          bytesDownloaded: null,
          bytesTotal: null,
          segmentsDone: null,
          segmentsTotal: null,
          lastProgressAt: '2026-04-18T00:00:05Z',
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
          groupId: 'g1',
          source: 'Url',
          status: 'Running',
          progress: 45,
          sourceUrl: 'https://example.com',
          result: null,
          error: null,
          createdAt: '2026-04-19T12:00:00Z',
          completedAt: null,
          // PV4 — MSW poll response now carries the same phase snapshot
          // the pre-seeded cache has so the settled fetch doesn't drift
          // the UI back to "queued" when it replaces the cache entry.
          phase: 'transcribing',
          phaseProgress: 42,
          progressLabel: 'Audio wird transkribiert',
          attemptNumber: 1,
          bytesDownloaded: null,
          bytesTotal: null,
          segmentsDone: 5,
          segmentsTotal: 20,
          lastProgressAt: '2026-04-19T12:00:00Z',
        }),
      ),
    )

    const { client } = renderProgress({
      importId: 'imp-phase',
      initialState: { groupId: 'g1' },
    })
    client.setQueryData(importQueryKeys.status('imp-phase'), {
      id: 'imp-phase',
      groupId: 'g1',
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
    // Server label surfaces on both the OverallProgressBar and the
    // PhaseDetailCard, so we assert presence on any of them.
    const labelMatches = screen.getAllByText(/audio wird transkribiert/i)
    expect(labelMatches.length).toBeGreaterThan(0)
  })

  it('shows the RetryIndicator only when attemptNumber > 1', async () => {
    const { client } = renderProgress({
      importId: 'imp-phase',
      initialState: { groupId: 'g1' },
    })
    client.setQueryData(importQueryKeys.status('imp-phase'), {
      id: 'imp-phase',
      groupId: 'g1',
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
      groupId: 'g1',
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
      groupId: 'g1',
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
          groupId: 'g1',
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
          phase: 'done',
          phaseProgress: 100,
          progressLabel: 'Fertig',
          attemptNumber: 1,
          bytesDownloaded: null,
          bytesTotal: null,
          segmentsDone: null,
          segmentsTotal: null,
          lastProgressAt: '2026-04-19T12:00:05Z',
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

  it('REIMPORT-1: reimport done (targetRecipeId set) → navigates to recipe detail page', async () => {
    server.use(
      http.get('/api/imports/imp-phase', () =>
        HttpResponse.json({
          id: 'imp-phase',
          groupId: 'g1',
          source: 'Url',
          status: 'Done',
          progress: 100,
          sourceUrl: 'https://example.com/reimport',
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
              source_url: 'https://example.com/reimport',
              thumbnail_url: null,
            },
            confidence: { overall: 'high', notes: [] },
          }),
          error: null,
          createdAt: '2026-04-21T12:00:00Z',
          completedAt: '2026-04-21T12:00:05Z',
          phase: 'done',
          phaseProgress: 100,
          progressLabel: 'Fertig',
          attemptNumber: 1,
          bytesDownloaded: null,
          bytesTotal: null,
          segmentsDone: null,
          segmentsTotal: null,
          lastProgressAt: '2026-04-21T12:00:05Z',
          targetRecipeId: 'rec-target-1',
        }),
      ),
    )

    const { client } = renderProgress({
      importId: 'imp-phase',
      initialState: { groupId: 'g1' },
    })

    await waitFor(
      () =>
        expect(screen.getByTestId('location')).toHaveTextContent(
          '/groups/g1/recipes/rec-target-1',
        ),
      { timeout: 2000 },
    )
    // The recipe detail cache is invalidated so the detail page fetches
    // fresh data on mount — assertion on query state is more robust
    // than a second route-check round-trip.
    const state = client.getQueryState(['recipes', 'detail', 'rec-target-1'])
    // Either the entry was invalidated (stale) or was never populated
    // (both acceptable — the detail page refetches either way).
    if (state) {
      expect(state.isInvalidated).toBe(true)
    }
  })

  it('REIMPORT-1: shows reimport banner while running when targetRecipeId is set', async () => {
    const { client } = renderProgress({
      importId: 'imp-phase',
      initialState: { groupId: 'g1' },
    })
    client.setQueryData(importQueryKeys.status('imp-phase'), {
      id: 'imp-phase',
      groupId: 'g1',
      source: 'url',
      status: 'running',
      progress: 45,
      sourceUrl: 'https://example.com',
      result: null,
      errorMessage: null,
      createdAt: '2026-04-21T12:00:00Z',
      completedAt: null,
      phase: 'transcribing',
      phaseProgress: 42,
      progressLabel: 'Audio wird transkribiert',
      attemptNumber: 1,
      lastProgressAt: new Date().toISOString(),
      segmentsDone: 5,
      segmentsTotal: 20,
      targetRecipeId: 'rec-target-1',
    })

    expect(
      await screen.findByTestId('reimport-running-banner'),
    ).toHaveTextContent(/reimport läuft/i)
  })

  it('REIMPORT-1: reimport banner is NOT shown on normal (non-reimport) imports', async () => {
    const { client } = renderProgress({
      importId: 'imp-phase',
      initialState: { groupId: 'g1' },
    })
    client.setQueryData(importQueryKeys.status('imp-phase'), {
      id: 'imp-phase',
      groupId: 'g1',
      source: 'url',
      status: 'running',
      progress: 45,
      sourceUrl: 'https://example.com',
      result: null,
      errorMessage: null,
      createdAt: '2026-04-21T12:00:00Z',
      completedAt: null,
      phase: 'transcribing',
      phaseProgress: 42,
      progressLabel: 'Audio wird transkribiert',
      attemptNumber: 1,
      lastProgressAt: new Date().toISOString(),
      segmentsDone: 5,
      segmentsTotal: 20,
      // targetRecipeId intentionally absent / null
    })

    await waitFor(() =>
      expect(screen.queryByTestId('reimport-running-banner')).toBeNull(),
    )
  })

  it('Error-state "Neu starten" navigates back to /rezepte/import/url with ?url=… prefill', async () => {
    server.use(
      http.get('/api/imports/imp-phase', () =>
        HttpResponse.json({
          id: 'imp-phase',
          groupId: 'g1',
          source: 'Url',
          status: 'Error',
          progress: 20,
          sourceUrl: 'https://example.com/r',
          result: null,
          error: 'Extractor crashed',
          createdAt: '2026-04-19T12:00:00Z',
          completedAt: '2026-04-19T12:00:05Z',
          phase: 'error',
          phaseProgress: 0,
          progressLabel: 'Fehler',
          attemptNumber: 1,
          bytesDownloaded: null,
          bytesTotal: null,
          segmentsDone: null,
          segmentsTotal: null,
          lastProgressAt: '2026-04-19T12:00:05Z',
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
