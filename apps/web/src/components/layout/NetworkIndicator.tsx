import { RotateCw } from 'lucide-react'
import { useNetworkStatus } from '@/features/offline/useNetworkStatus'
import { cn } from '@/lib/utils'

/**
 * OFF2 — small pill in the top-nav that reflects:
 *   - browser connectivity (`navigator.onLine` + window events)
 *   - pending service-worker mutation replays
 *
 * Visible states:
 *   - `online && pendingReplayCount === 0` ⇒ nothing (the happy-path
 *     UI shouldn't nag the user when everything is fine)
 *   - `!online` ⇒ amber dot + "Offline"
 *   - `online && pendingReplayCount > 0` ⇒ rotating-arrow icon + "N
 *     wartend" (i.e. writes that will replay once the queue drains)
 *
 * a11y: `role="status"` + `aria-live="polite"` so screen-readers are
 * notified when connectivity flips or the queue drains. We render an
 * empty `<span>` with the ARIA attributes even on the happy path so
 * the live region has a stable host — toggling the wrapper in and out
 * of the DOM defeats polite announcements.
 */
export function NetworkIndicator() {
  const { online, pendingReplayCount } = useNetworkStatus()

  const showOffline = !online
  const showPending = online && pendingReplayCount > 0

  // Empty live-region host keeps assistive tech subscribed; the visible
  // content swaps in/out without destroying the region.
  if (!showOffline && !showPending) {
    return (
      <span
        role="status"
        aria-live="polite"
        className="sr-only"
        data-testid="network-indicator-idle"
      />
    )
  }

  return (
    <span
      role="status"
      aria-live="polite"
      data-testid="network-indicator"
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium leading-none',
        showOffline &&
          'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100',
        showPending &&
          'bg-sky-100 text-sky-900 dark:bg-sky-900/40 dark:text-sky-100',
      )}
    >
      {showOffline && (
        <>
          <span
            aria-hidden="true"
            className="inline-block h-2 w-2 rounded-full bg-amber-600"
          />
          <span>Offline</span>
        </>
      )}
      {showPending && (
        <>
          <RotateCw
            aria-hidden="true"
            className="h-3.5 w-3.5 animate-spin [animation-duration:3s]"
          />
          <span>{pendingReplayCount} wartend</span>
        </>
      )}
    </span>
  )
}
