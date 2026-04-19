import { beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import {
  DEFAULT_IMPORT_POLL_MS,
  SIGNALR_FRESH_WINDOW_MS,
  useEnqueueUrlImport,
  useImportStatus,
} from './hooks'
import {
  clearImportLiveEvents,
  recordImportLiveEvent,
} from './liveEventTimestamp'

beforeEach(() => {
  useAuthStore.setState({
    accessToken: 't',
    user: { id: 'u1', email: 'u1@ex.com', displayName: 'U', role: 'User' },
  })
  clearImportLiveEvents()
})

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
}

describe('useEnqueueUrlImport', () => {
  it('POSTs the url+groupId and resolves with importId', async () => {
    server.use(
      http.post('/api/recipes/import/url', () =>
        HttpResponse.json({ importId: 'imp-xyz' }, { status: 202 }),
      ),
    )
    const { result } = renderHook(() => useEnqueueUrlImport(), {
      wrapper: makeWrapper(),
    })
    const res = await result.current.mutateAsync({
      url: 'https://example.com/r',
      groupId: 'g1',
    })
    expect(res.importId).toBe('imp-xyz')
  })
})

describe('useImportStatus', () => {
  it('returns the normalised DTO on first poll', async () => {
    server.use(
      http.get('/api/imports/imp-1', () =>
        HttpResponse.json({
          id: 'imp-1',
          source: 'Url',
          status: 'Running',
          progress: 10,
          sourceUrl: 'https://example.com',
          result: null,
          error: null,
          createdAt: '2026-04-18T00:00:00Z',
          completedAt: null,
        }),
      ),
    )
    const { result } = renderHook(() => useImportStatus('imp-1'), {
      wrapper: makeWrapper(),
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.status).toBe('running')
    expect(result.current.data?.progress).toBe(10)
  })

  it('is disabled when importId is undefined', () => {
    const { result } = renderHook(() => useImportStatus(undefined), {
      wrapper: makeWrapper(),
    })
    expect(result.current.fetchStatus).toBe('idle')
  })

  it('stops polling once status transitions to done (refetchInterval returns false)', async () => {
    let calls = 0
    server.use(
      http.get('/api/imports/imp-2', () => {
        calls += 1
        // First response: still running. Subsequent: done. But the
        // hook must stop polling as soon as it sees "done", so we
        // should never see more than 2 calls (one running, one done).
        if (calls === 1) {
          return HttpResponse.json({
            id: 'imp-2',
            source: 'Url',
            status: 'Running',
            progress: 50,
            sourceUrl: 'https://example.com',
            result: null,
            error: null,
            createdAt: '2026-04-18T00:00:00Z',
            completedAt: null,
          })
        }
        return HttpResponse.json({
          id: 'imp-2',
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
          completedAt: '2026-04-18T00:00:30Z',
        })
      }),
    )

    // Use a tiny interval so the test does not take 2 s.
    const { result } = renderHook(
      () => useImportStatus('imp-2', { refetchInterval: 30 }),
      { wrapper: makeWrapper() },
    )

    // Wait for the "done" state to land.
    await waitFor(() => expect(result.current.data?.status).toBe('done'))

    // Give the interval a couple of extra cycles to misbehave.
    const callsAtSettle = calls
    await new Promise((r) => setTimeout(r, 120))
    expect(calls).toBe(callsAtSettle)
  })

  it('defaults the poll interval to 3s per PV3', () => {
    // Guard-rail: the numeric constant is exported so downstream
    // consumers (scripts/smoke-live, docs) reference it without forking
    // their own copy. A drift here is a plan-coordination bug.
    expect(DEFAULT_IMPORT_POLL_MS).toBe(3000)
    expect(SIGNALR_FRESH_WINDOW_MS).toBe(2000)
  })

  it('backs off the poll cadence by ~2x when SignalR events are fresh vs stale', async () => {
    // Collect two timeseries of poll counts — one where every poll
    // sees a fresh SignalR timestamp (so the interval doubles each
    // evaluation), one where the timestamp is stale. The hook doubles
    // the interval when `fresh` is true, so over the same wall-clock
    // window we expect roughly HALF as many fetches.
    async function runOnce({ fresh }: { fresh: boolean }): Promise<number> {
      let calls = 0
      server.use(
        http.get('/api/imports/imp-sig', () => {
          calls += 1
          return HttpResponse.json({
            id: 'imp-sig',
            source: 'Url',
            status: 'Running',
            progress: 50,
            sourceUrl: 'https://example.com',
            result: null,
            error: null,
            createdAt: '2026-04-18T00:00:00Z',
            completedAt: null,
          })
        }),
      )
      clearImportLiveEvents()
      if (fresh) recordImportLiveEvent('imp-sig')
      const { unmount, result } = renderHook(
        () => useImportStatus('imp-sig', { refetchInterval: 20 }),
        { wrapper: makeWrapper() },
      )
      await waitFor(() => expect(result.current.data?.status).toBe('running'))
      await new Promise((r) => setTimeout(r, 120))
      unmount()
      return calls
    }

    const staleCalls = await runOnce({ fresh: false })
    const freshCalls = await runOnce({ fresh: true })

    // PV3 simplification: the prior `freshCalls <= staleCalls`
    // assertion passed even when the back-off did nothing (e.g. both
    // equal to 1). The hook doubles the interval on fresh events, so
    // we assert the ratio directly: `freshCalls * 2` should equal
    // `staleCalls` give-or-take two scheduling ticks of jitter from
    // the interval evaluator + scheduler dispatch boundary (±1 each).
    // A pre-fix implementation that didn't back off would have
    // `freshCalls === staleCalls`, failing both assertions.
    expect(staleCalls).toBeGreaterThan(freshCalls)
    expect(Math.abs(freshCalls * 2 - staleCalls)).toBeLessThanOrEqual(2)
  })

  it('stops polling once status transitions to error', async () => {
    let calls = 0
    server.use(
      http.get('/api/imports/imp-3', () => {
        calls += 1
        if (calls === 1) {
          return HttpResponse.json({
            id: 'imp-3',
            source: 'Url',
            status: 'Running',
            progress: 20,
            sourceUrl: 'https://example.com',
            result: null,
            error: null,
            createdAt: '2026-04-18T00:00:00Z',
            completedAt: null,
          })
        }
        return HttpResponse.json({
          id: 'imp-3',
          source: 'Url',
          status: 'Error',
          progress: 20,
          sourceUrl: 'https://example.com',
          result: null,
          error: 'Privat oder nicht verfügbar.',
          createdAt: '2026-04-18T00:00:00Z',
          completedAt: '2026-04-18T00:00:05Z',
        })
      }),
    )

    const { result } = renderHook(
      () => useImportStatus('imp-3', { refetchInterval: 30 }),
      { wrapper: makeWrapper() },
    )

    await waitFor(() => expect(result.current.data?.status).toBe('error'))
    const callsAtSettle = calls
    await new Promise((r) => setTimeout(r, 120))
    expect(calls).toBe(callsAtSettle)
  })
})
