import { useEffect, useRef } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import {
  LiveSyncEventNames,
  type MealPlanChangedPayload,
  type MealPlanSlotChangedPayload,
  type ShoppingListItemChangedPayload,
} from '@familien-kochbuch/shared'
import { mealPlanQueryKeys } from '@/features/mealplanning/useMealPlan'
import { shoppingListQueryKeys } from '@/features/shoppinglist/useShoppingList'
import { useAuthStore } from '@/features/auth/authStore'
import {
  createSignalRLiveSyncClient,
  type LiveSyncClient,
} from './liveSyncClient'

/**
 * Factory for the SignalR client. Defaults to the real WebSockets
 * implementation; tests inject a fake so assertions can directly fire
 * events without a network stack.
 */
export type LiveSyncClientFactory = (
  url: string,
  accessTokenFactory: () => string | null,
) => LiveSyncClient

const DEFAULT_HUB_URL = '/api/hubs/live'

/**
 * P3-8 hook: subscribes to the backend's <c>LiveSyncHub</c> and routes
 * server events into TanStack-Query cache invalidations. Invoke ONCE
 * at the App/ProtectedRoute level — per-page subscribes would fan out
 * as many sockets as mounted pages.
 *
 * Reconnect is owned by the underlying SignalR client with a backoff
 * aligned to <see cref="reconnectBackoff.ts"/>. On unmount the
 * connection is stopped cleanly.
 */
export function useLiveSync(options?: {
  clientFactory?: LiveSyncClientFactory
  hubUrl?: string
}) {
  const queryClient = useQueryClient()
  const accessToken = useAuthStore((s) => s.accessToken)
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)

  // Keep the latest accessToken inside a ref so the factory closure we
  // pass down can read it without re-instantiating the connection on
  // every token rotation — SignalR calls the factory on each
  // (re)connect.
  const tokenRef = useRef(accessToken)
  useEffect(() => {
    tokenRef.current = accessToken
  }, [accessToken])

  const clientFactory = options?.clientFactory ?? createSignalRLiveSyncClient
  const hubUrl = options?.hubUrl ?? DEFAULT_HUB_URL

  useEffect(() => {
    if (!isAuthenticated || !accessToken) {
      return
    }

    const client = clientFactory(hubUrl, () => tokenRef.current)
    wireEventHandlers(client, queryClient)

    let disposed = false
    void client
      .start()
      .catch((error) => {
        // Don't surface connection failures as uncaught rejections —
        // SignalR's own retry policy will pick them up. Log once so
        // operators can still see a broken proxy config if the backoff
        // exhausts.
        if (!disposed) {
          console.warn('[useLiveSync] initial connect failed', error)
        }
      })

    return () => {
      disposed = true
      void client.stop()
    }
    // `clientFactory` + `hubUrl` are stable per-mount because callers
    // almost always pass literals; react-hooks would still like them
    // in the dep array, but re-subscribing on either change is the
    // intended behaviour.
  }, [isAuthenticated, accessToken, clientFactory, hubUrl, queryClient])
}

/**
 * Registers the three server-→-client event handlers. Extracted so
 * the hook body stays focused on lifecycle + the cache-fanout logic
 * can be covered by a unit test that sidesteps useEffect scheduling.
 */
export function wireEventHandlers(
  client: LiveSyncClient,
  queryClient: QueryClient,
): void {
  client.on<MealPlanSlotChangedPayload>(
    LiveSyncEventNames.MealPlanSlotChanged,
    (payload) => {
      void queryClient.invalidateQueries({
        queryKey: mealPlanQueryKeys.forWeek(payload.groupId, payload.weekStart),
      })
    },
  )
  client.on<MealPlanChangedPayload>(
    LiveSyncEventNames.MealPlanChanged,
    (payload) => {
      void queryClient.invalidateQueries({
        queryKey: mealPlanQueryKeys.forWeek(payload.groupId, payload.weekStart),
      })
    },
  )
  client.on<ShoppingListItemChangedPayload>(
    LiveSyncEventNames.ShoppingListItemChanged,
    (payload) => {
      void queryClient.invalidateQueries({
        queryKey: shoppingListQueryKeys.forPlan(payload.planId),
      })
    },
  )
}
