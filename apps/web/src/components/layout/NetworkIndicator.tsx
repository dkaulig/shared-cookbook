import { useEffect, useRef, useState } from 'react'
import { Check, RotateCw } from 'lucide-react'
import { useNetworkStatus } from '@/features/offline/useNetworkStatus'
import { cn } from '@/lib/utils'

/**
 * OFF2 (+ OFF5 polish) — small pill in the top-nav that reflects:
 *   - browser connectivity (`navigator.onLine` + window events)
 *   - pending service-worker mutation replays
 *
 * Visible states:
 *   - `online && pendingReplayCount === 0 && !flashSynced` ⇒ nothing
 *     (the happy-path UI shouldn't nag the user when everything is fine)
 *   - `!online` ⇒ amber dot + "Offline"
 *   - `online && pendingReplayCount > 0` ⇒ rotating-arrow icon + "N
 *     wartend" (i.e. writes that will replay once the queue drains)
 *   - `online && justReconnectedAfterPending` ⇒ transient green pill
 *     "↻ N synchronisieren" for ~2s, then back to idle (OFF5 polish —
 *     gives the user a quick "we caught up" confirmation).
 *
 * OFF5 polish:
 *   - Fade-in/slide-down transition on the offline pill so the state-
 *     change is visible instead of a jarring swap.
 *   - Transient "synchronisieren" green pill after replay confirms the
 *     sync to the user; hides itself automatically after 2s.
 *
 * a11y: `role="status"` + `aria-live="polite"` so screen-readers are
 * notified when connectivity flips or the queue drains. We render an
 * empty `<span>` with the ARIA attributes even on the happy path so
 * the live region has a stable host — toggling the wrapper in and out
 * of the DOM defeats polite announcements.
 */
export function NetworkIndicator() {
  const { online, pendingReplayCount } = useNetworkStatus()

  // OFF5 — transient "N synchronisieren" state. Triggered when we
  // observe a replay finish AND there were queued entries to drain
  // (either we just flipped online, or replay fired during online
  // lifetime after a queue filled). Auto-hides 2s later.
  const [flashCount, setFlashCount] = useState(0)
  const prevPendingRef = useRef(pendingReplayCount)
  const prevOnlineRef = useRef(online)

  useEffect(() => {
    const prevPending = prevPendingRef.current
    const prevOnline = prevOnlineRef.current
    prevPendingRef.current = pendingReplayCount
    prevOnlineRef.current = online

    // Trigger the synchronised-flash when:
    //   (a) we just came back online AND there were pending replays
    //       that dropped to 0 in the same tick (pending reset by the
    //       replay signal), OR
    //   (b) we were already online and saw pending drop from >0 → 0
    //       (successful drain while staying online).
    const justReconnected = !prevOnline && online
    const pendingDrained = prevPending > 0 && pendingReplayCount === 0
    if (pendingDrained && (justReconnected || prevOnline)) {
      setFlashCount(prevPending)
    }
  }, [online, pendingReplayCount])

  useEffect(() => {
    if (flashCount === 0) return
    const t = window.setTimeout(() => setFlashCount(0), 2000)
    return () => window.clearTimeout(t)
  }, [flashCount])

  const showOffline = !online
  const showPending = online && pendingReplayCount > 0
  const showFlash = online && !showPending && flashCount > 0

  // Empty live-region host keeps assistive tech subscribed; the visible
  // content swaps in/out without destroying the region.
  if (!showOffline && !showPending && !showFlash) {
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
        // OFF5 — slight slide-down + fade-in on state entry. The CSS
        // `transition-[opacity,transform]` is always-on, and the initial
        // `opacity-0 translate-y-[-4px]` classes are applied on mount
        // via the data-state attribute below.
        'transition-[opacity,transform] duration-200 ease-out',
        showOffline &&
          'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100',
        showPending &&
          'bg-sky-100 text-sky-900 dark:bg-sky-900/40 dark:text-sky-100',
        showFlash &&
          'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100',
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
      {showFlash && (
        <>
          <Check
            aria-hidden="true"
            className="h-3.5 w-3.5"
          />
          <span data-testid="network-indicator-flash">
            {flashCount} synchronisiert
          </span>
        </>
      )}
    </span>
  )
}
