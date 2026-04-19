import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook } from '@testing-library/react'
import { HubConnectionState } from '@microsoft/signalr'
import {
  LiveSyncEventNames,
  type MealPlanChangedPayload,
  type MealPlanSlotChangedPayload,
  type ShoppingListItemChangedPayload,
} from '@familien-kochbuch/shared'
import { useAuthStore } from '@/features/auth/authStore'
import { mealPlanQueryKeys } from '@/features/mealplanning/useMealPlan'
import { shoppingListQueryKeys } from '@/features/shoppinglist/useShoppingList'
import { useLiveSync, wireEventHandlers } from './useLiveSync'
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

  it('wires all three event names exactly once', () => {
    const queryClient = new QueryClient()
    const fake = new FakeLiveSyncClient()
    wireEventHandlers(fake, queryClient)

    expect(Array.from(fake.handlers.keys()).sort()).toEqual(
      [
        LiveSyncEventNames.MealPlanChanged,
        LiveSyncEventNames.MealPlanSlotChanged,
        LiveSyncEventNames.ShoppingListItemChanged,
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
