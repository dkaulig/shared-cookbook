import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useSwMessage } from './useSwMessage'

/**
 * OFF2 — after the service worker drains the `fk-mutation-queue` and
 * posts a `fk-mutation-replayed` message, invalidate every query key
 * family a queued mutation could have touched. The server is
 * authoritative post-replay, so we bias toward a broad refetch rather
 * than tracking which resource each queued request mutated — narrower
 * targeted invalidation would require the SW to decode queued URLs +
 * extract IDs, which isn't worth the complexity for a hobby app.
 *
 * Integration note: jsdom doesn't implement `serviceWorker`, so the
 * end-to-end SW replay is out of scope for vitest. The Playwright
 * offline smoke at `apps/web/e2e/offline.spec.ts` (OFF5) covers the
 * read-cache + indicator contract against the real built SW; the
 * mutation-replay contract stays vitest-scope because Playwright's
 * `setOffline` can't reliably proxy the Workbox `BackgroundSyncPlugin`
 * behavior.
 */
export function useBackgroundSyncMessage(): void {
  const queryClient = useQueryClient()

  const onMessage = useCallback(
    (event: MessageEvent) => {
      const data = event.data as { type?: string } | undefined
      if (data?.type !== 'fk-mutation-replayed') return
      // Query-key prefixes align with the existing `*QueryKeys.all`
      // factories (recipes: ['recipes'], mealplan: ['mealplan'],
      // shoppinglist: ['shoppinglist'], ratings: ['ratings']). Keep
      // these in lockstep with those key factories if any rename.
      void queryClient.invalidateQueries({ queryKey: ['recipes'] })
      void queryClient.invalidateQueries({ queryKey: ['mealplan'] })
      void queryClient.invalidateQueries({ queryKey: ['shoppinglist'] })
      void queryClient.invalidateQueries({ queryKey: ['ratings'] })
    },
    [queryClient],
  )

  useSwMessage(onMessage)
}
