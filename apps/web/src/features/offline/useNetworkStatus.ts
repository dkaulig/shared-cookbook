import { useCallback, useEffect, useState } from 'react'
import { useSwMessage } from './useSwMessage'

export interface NetworkStatus {
  /** Whether the browser currently thinks we're online. Mirrors
   *  `navigator.onLine` + the `online`/`offline` window events. */
  online: boolean
  /** Number of mutations the SW has queued but not yet replayed. Best
   *  effort — see note on the enqueue-side message below. */
  pendingReplayCount: number
}

/**
 * OFF2 — combines browser connectivity state with the service worker's
 * mutation-queue telemetry so the top-nav `NetworkIndicator` can
 * render a single pill. The hook listens for three signals:
 *
 *  1. `window` `online`/`offline` — the browser's own network change
 *     events drive the `online` flag.
 *  2. SW `fk-mutation-queued` — posted from a custom plugin hook when
 *     a request is appended to the background-sync queue. Increments
 *     pending.
 *  3. SW `fk-mutation-replayed` — posted from the queue's `onSync`
 *     callback after successful drain. Resets pending to 0.
 *
 * Scope note: the current `generateSW` Workbox mode doesn't let us
 * emit `fk-mutation-queued` without switching to `injectManifest` (we
 * have no owned SW source file to subclass `BackgroundSyncPlugin`
 * from). For this slice we accept a reduced UX — `pendingReplayCount`
 * starts at 0 and only resets on the replay signal. Offline users
 * still see the "Offline" pill via signal #1, which is the more
 * important of the two indicators. Full pending-count telemetry is
 * tracked as an offline-v2 follow-up (would require migrating to
 * `injectManifest` + an owned SW source).
 */
export function useNetworkStatus(): NetworkStatus {
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  )
  const [pending, setPending] = useState(0)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const goOnline = () => setOnline(true)
    const goOffline = () => setOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])

  const onSwMessage = useCallback((event: MessageEvent) => {
    const data = event.data as { type?: string } | undefined
    if (data?.type === 'fk-mutation-queued') {
      setPending((p) => p + 1)
    } else if (data?.type === 'fk-mutation-replayed') {
      setPending(0)
    }
  }, [])

  useSwMessage(onSwMessage)

  return { online, pendingReplayCount: pending }
}
