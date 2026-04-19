import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook } from '@testing-library/react'
import { HubConnectionState } from '@microsoft/signalr'
import {
  LiveSyncEventNames,
  type MealPlanChangedPayload,
  type MealPlanSlotChangedPayload,
  type RecipeImportDto,
  type RecipeImportProgressEventPayload,
  type ShoppingListItemChangedPayload,
} from '@familien-kochbuch/shared'
import { useAuthStore } from '@/features/auth/authStore'
import { mealPlanQueryKeys } from '@/features/mealplanning/useMealPlan'
import { shoppingListQueryKeys } from '@/features/shoppinglist/useShoppingList'
import { importQueryKeys } from '@/features/imports/hooks'
import {
  clearImportLiveEvents,
  readImportLiveEventAt,
} from '@/features/imports/liveEventTimestamp'
import {
  applyImportProgressEvent,
  useLiveSync,
  wireEventHandlers,
} from './useLiveSync'
import type { LiveSyncClient } from './liveSyncClient'

/**
 * In-memory fake SignalR client — the tests fire events through
 * `emit(eventName, payload)` to exercise the hook's fan-out logic
 * without a real socket. Keeps the hook DI-shaped (factory injection)
 * rather than monkey-patching the module.
 */
class FakeLiveSyncClient implements LiveSyncClient {
  public readonly handlers: Map<string, (payload: unknown) => void> = new Map()
  public started = 0
  public stopped = 0
  public state: HubConnectionState = HubConnectionState.Disconnected

  async start(): Promise<void> {
    this.started++
    this.state = HubConnectionState.Connected
  }

  async stop(): Promise<void> {
    this.stopped++
    this.state = HubConnectionState.Disconnected
  }

  on<T>(eventName: string, handler: (payload: T) => void): void {
    this.handlers.set(eventName, handler as (p: unknown) => void)
  }

  off(eventName: string): void {
    this.handlers.delete(eventName)
  }

  emit(eventName: string, payload: unknown): void {
    const handler = this.handlers.get(eventName)
    if (!handler) throw new Error(`no handler for ${eventName}`)
    handler(payload)
  }
}

function withClient(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

function setAuthenticated(): void {
  useAuthStore.setState({
    accessToken: 'test-token',
    user: { id: 'u1', email: 'u@ex.com', displayName: 'U', role: 'User' },
    isAuthenticated: true,
  })
}

beforeEach(() => {
  useAuthStore.getState().clear()
  clearImportLiveEvents()
})

describe('useLiveSync', () => {
  it('does not connect when unauthenticated', () => {
    const queryClient = new QueryClient()
    const fake = new FakeLiveSyncClient()
    renderHook(
      () =>
        useLiveSync({
          clientFactory: () => fake,
        }),
      { wrapper: withClient(queryClient) },
    )

    expect(fake.started).toBe(0)
  })

  it('connects on mount when authenticated', async () => {
    setAuthenticated()
    const queryClient = new QueryClient()
    const fake = new FakeLiveSyncClient()
    renderHook(
      () =>
        useLiveSync({
          clientFactory: () => fake,
        }),
      { wrapper: withClient(queryClient) },
    )

    // start() is async fire-and-forget inside useEffect — yield so it
    // completes before we assert.
    await Promise.resolve()
    expect(fake.started).toBe(1)
  })

  it('disconnects cleanly on unmount', async () => {
    setAuthenticated()
    const queryClient = new QueryClient()
    const fake = new FakeLiveSyncClient()
    const { unmount } = renderHook(
      () =>
        useLiveSync({
          clientFactory: () => fake,
        }),
      { wrapper: withClient(queryClient) },
    )
    await Promise.resolve()
    unmount()
    expect(fake.stopped).toBe(1)
  })

  it('passes the current accessToken via the token factory', async () => {
    setAuthenticated()
    const queryClient = new QueryClient()
    let capturedFactory: (() => string | null) | null = null
    const fake = new FakeLiveSyncClient()
    renderHook(
      () =>
        useLiveSync({
          clientFactory: (_url, factory) => {
            capturedFactory = factory
            return fake
          },
        }),
      { wrapper: withClient(queryClient) },
    )
    await Promise.resolve()
    expect(capturedFactory).toBeTruthy()
    expect(capturedFactory!()).toBe('test-token')
  })

  it('invalidates the mealplan cache on MealPlanSlotChanged', () => {
    const queryClient = new QueryClient()
    const spy = vi.spyOn(queryClient, 'invalidateQueries')
    const fake = new FakeLiveSyncClient()
    wireEventHandlers(fake, queryClient)

    const payload: MealPlanSlotChangedPayload = {
      planId: 'p1',
      slotId: 's1',
      groupId: 'g1',
      weekStart: '2026-04-20',
      action: 'updated',
    }
    fake.emit(LiveSyncEventNames.MealPlanSlotChanged, payload)

    expect(spy).toHaveBeenCalledWith({
      queryKey: mealPlanQueryKeys.forWeek('g1', '2026-04-20'),
    })
  })

  it('invalidates the mealplan cache on MealPlanChanged', () => {
    const queryClient = new QueryClient()
    const spy = vi.spyOn(queryClient, 'invalidateQueries')
    const fake = new FakeLiveSyncClient()
    wireEventHandlers(fake, queryClient)

    const payload: MealPlanChangedPayload = {
      planId: 'p1',
      groupId: 'g2',
      weekStart: '2026-04-27',
      action: 'created',
    }
    fake.emit(LiveSyncEventNames.MealPlanChanged, payload)

    expect(spy).toHaveBeenCalledWith({
      queryKey: mealPlanQueryKeys.forWeek('g2', '2026-04-27'),
    })
  })

  it('invalidates the shoppinglist cache on ShoppingListItemChanged', () => {
    const queryClient = new QueryClient()
    const spy = vi.spyOn(queryClient, 'invalidateQueries')
    const fake = new FakeLiveSyncClient()
    wireEventHandlers(fake, queryClient)

    const payload: ShoppingListItemChangedPayload = {
      listId: 'l1',
      itemId: 'i1',
      planId: 'p1',
      action: 'deleted',
    }
    fake.emit(LiveSyncEventNames.ShoppingListItemChanged, payload)

    expect(spy).toHaveBeenCalledWith({
      queryKey: shoppingListQueryKeys.forPlan('p1'),
    })
  })

  it('wires all four event names exactly once', () => {
    const queryClient = new QueryClient()
    const fake = new FakeLiveSyncClient()
    wireEventHandlers(fake, queryClient)

    expect(Array.from(fake.handlers.keys()).sort()).toEqual(
      [
        LiveSyncEventNames.MealPlanChanged,
        LiveSyncEventNames.MealPlanSlotChanged,
        LiveSyncEventNames.ShoppingListItemChanged,
        LiveSyncEventNames.RecipeImportProgressChanged,
      ].sort(),
    )
  })

  it('does not leak events across independent query clients', () => {
    const clientA = new QueryClient()
    const clientB = new QueryClient()
    const spyA = vi.spyOn(clientA, 'invalidateQueries')
    const spyB = vi.spyOn(clientB, 'invalidateQueries')
    const fakeA = new FakeLiveSyncClient()
    const fakeB = new FakeLiveSyncClient()
    wireEventHandlers(fakeA, clientA)
    wireEventHandlers(fakeB, clientB)

    const payload: MealPlanSlotChangedPayload = {
      planId: 'p',
      slotId: 's',
      groupId: 'g',
      weekStart: '2026-04-20',
      action: 'updated',
    }
    fakeA.emit(LiveSyncEventNames.MealPlanSlotChanged, payload)

    expect(spyA).toHaveBeenCalled()
    expect(spyB).not.toHaveBeenCalled()
  })

  it('uses a stable hub URL when none is supplied', async () => {
    setAuthenticated()
    const queryClient = new QueryClient()
    let capturedUrl = ''
    const fake = new FakeLiveSyncClient()
    renderHook(
      () =>
        useLiveSync({
          clientFactory: (url) => {
            capturedUrl = url
            return fake
          },
        }),
      { wrapper: withClient(queryClient) },
    )
    await Promise.resolve()
    expect(capturedUrl).toBe('/api/hubs/live')
  })

  it('RecipeImportProgressChanged writes the payload to the cache via setQueryData (no invalidation)', () => {
    const queryClient = new QueryClient()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    const setSpy = vi.spyOn(queryClient, 'setQueryData')
    const fake = new FakeLiveSyncClient()
    wireEventHandlers(fake, queryClient)

    // PV3 security guard: the handler only merges into an existing cache
    // entry (phantom-DTO synthesis would let an attacker influence the
    // PhaseStepper source-branch until the REST GET settled). So we
    // seed a minimal DTO here to exercise the merge path.
    const seeded: RecipeImportDto = {
      id: '11111111-2222-3333-4444-555555555555',
      groupId: '22222222-3333-4444-5555-666666666666',
      source: 'url',
      status: 'running',
      progress: 0,
      sourceUrl: 'https://example.com/r',
      result: null,
      errorMessage: null,
      createdAt: '2026-04-19T12:00:00Z',
      completedAt: null,
    }
    queryClient.setQueryData(importQueryKeys.status(seeded.id), seeded)
    // Clear the invalidate+set spies' seed call so the assertions below
    // reflect only the handler's work.
    setSpy.mockClear()

    const payload: RecipeImportProgressEventPayload = {
      importId: seeded.id,
      groupId: '22222222-3333-4444-5555-666666666666',
      phase: 'transcribing',
      progress: 45,
      phaseProgress: 42,
      progressLabel: 'Audio wird transkribiert',
      attemptNumber: 1,
      bytesDownloaded: null,
      bytesTotal: null,
      segmentsDone: 5,
      segmentsTotal: 20,
    }
    fake.emit(LiveSyncEventNames.RecipeImportProgressChanged, payload)

    // The handler applies the payload directly.
    expect(setSpy).toHaveBeenCalled()
    // Spec-critical: no invalidation — the payload IS authoritative.
    expect(invalidateSpy).not.toHaveBeenCalled()

    const cached = queryClient.getQueryData<RecipeImportDto>(
      importQueryKeys.status(payload.importId),
    )
    expect(cached?.phase).toBe('transcribing')
    expect(cached?.progress).toBe(45)
    expect(cached?.phaseProgress).toBe(42)
    expect(cached?.progressLabel).toBe('Audio wird transkribiert')
    expect(cached?.segmentsDone).toBe(5)
    expect(cached?.segmentsTotal).toBe(20)

    // The liveEventTimestamp side-channel is updated so useImportStatus
    // can back off its poll cadence.
    expect(readImportLiveEventAt(payload.importId)).not.toBeNull()
  })

  // PV3 security regression: without the phantom-DTO guard, a
  // RecipeImportProgressChanged event for an importId the client has
  // never GET'd would fabricate a DTO with `source: 'url'` defaults —
  // letting the PhaseStepper render the wrong source-branch (or, more
  // dangerously, letting a same-group event overwrite unrelated
  // cache entries). We skip the merge silently when prev is absent;
  // the 3s poll fallback converges state within one cycle.
  it('applyImportProgressEvent SKIPS setQueryData when no prior cache exists (security)', () => {
    const queryClient = new QueryClient()
    applyImportProgressEvent(queryClient, {
      importId: 'imp-no-prev',
      groupId: 'g1',
      phase: 'transcribing',
      progress: 45,
      phaseProgress: 42,
      progressLabel: 'Audio wird transkribiert',
      attemptNumber: 1,
    })
    const cached = queryClient.getQueryData<RecipeImportDto>(
      importQueryKeys.status('imp-no-prev'),
    )
    // No phantom DTO was synthesised — cache stays empty for this id.
    expect(cached).toBeUndefined()
    // Freshness side-channel still records the event so the poll
    // back-off can apply on the next tick once the GET lands.
    expect(readImportLiveEventAt('imp-no-prev')).not.toBeNull()
  })

  it('RecipeImportProgressChanged preserves prior DTO fields (source, sourceUrl)', () => {
    const queryClient = new QueryClient()
    const fake = new FakeLiveSyncClient()
    wireEventHandlers(fake, queryClient)

    const seeded: RecipeImportDto = {
      id: '11111111-2222-3333-4444-555555555555',
      groupId: '22222222-3333-4444-5555-666666666666',
      source: 'photos',
      status: 'running',
      progress: 5,
      sourceUrl: 'https://example.com/r',
      result: null,
      errorMessage: null,
      createdAt: '2026-04-19T12:00:00Z',
      completedAt: null,
    }
    queryClient.setQueryData(importQueryKeys.status(seeded.id), seeded)

    const payload: RecipeImportProgressEventPayload = {
      importId: seeded.id,
      groupId: '22222222-3333-4444-5555-666666666666',
      phase: 'vision_analysis',
      progress: 50,
      phaseProgress: 50,
      progressLabel: 'Fotos werden analysiert (Azure Vision)',
      attemptNumber: 1,
    }
    fake.emit(LiveSyncEventNames.RecipeImportProgressChanged, payload)

    const merged = queryClient.getQueryData<RecipeImportDto>(
      importQueryKeys.status(seeded.id),
    )
    // Prior fields survive: source + sourceUrl were only on the cached
    // DTO, not on the event payload.
    expect(merged?.source).toBe('photos')
    expect(merged?.sourceUrl).toBe('https://example.com/r')
    // Event fields applied.
    expect(merged?.phase).toBe('vision_analysis')
    expect(merged?.progress).toBe(50)
  })

  it('applyImportProgressEvent flips status to done on terminal Done phase', () => {
    const queryClient = new QueryClient()
    // Seed the cache so the merge happens (see phantom-DTO guard above).
    const seeded: RecipeImportDto = {
      id: 'imp-done',
      groupId: 'g1',
      source: 'url',
      status: 'running',
      progress: 90,
      sourceUrl: 'https://example.com/r',
      result: null,
      errorMessage: null,
      createdAt: '2026-04-19T12:00:00Z',
      completedAt: null,
    }
    queryClient.setQueryData(importQueryKeys.status(seeded.id), seeded)
    applyImportProgressEvent(queryClient, {
      importId: 'imp-done',
      groupId: 'g1',
      phase: 'done',
      progress: 100,
      phaseProgress: 100,
      progressLabel: 'Fertig.',
      attemptNumber: 1,
    })
    const cached = queryClient.getQueryData<RecipeImportDto>(
      importQueryKeys.status('imp-done'),
    )
    expect(cached?.status).toBe('done')
    expect(cached?.phase).toBe('done')
  })

  it('applyImportProgressEvent flips status to error on terminal Error phase', () => {
    const queryClient = new QueryClient()
    const seeded: RecipeImportDto = {
      id: 'imp-err',
      groupId: 'g1',
      source: 'url',
      status: 'running',
      progress: 10,
      sourceUrl: 'https://example.com/r',
      result: null,
      errorMessage: null,
      createdAt: '2026-04-19T12:00:00Z',
      completedAt: null,
    }
    queryClient.setQueryData(importQueryKeys.status(seeded.id), seeded)
    applyImportProgressEvent(queryClient, {
      importId: 'imp-err',
      groupId: 'g1',
      phase: 'error',
      progress: 10,
      phaseProgress: 0,
      progressLabel: 'Fehler.',
      attemptNumber: 2,
    })
    const cached = queryClient.getQueryData<RecipeImportDto>(
      importQueryKeys.status('imp-err'),
    )
    expect(cached?.status).toBe('error')
    expect(cached?.attemptNumber).toBe(2)
  })

  it('respects an override hubUrl when supplied', async () => {
    setAuthenticated()
    const queryClient = new QueryClient()
    let capturedUrl = ''
    const fake = new FakeLiveSyncClient()
    renderHook(
      () =>
        useLiveSync({
          hubUrl: '/custom/hub',
          clientFactory: (url) => {
            capturedUrl = url
            return fake
          },
        }),
      { wrapper: withClient(queryClient) },
    )
    await Promise.resolve()
    expect(capturedUrl).toBe('/custom/hub')
  })
})
