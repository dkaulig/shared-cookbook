import { useSyncExternalStore } from 'react'
import { AlertCircle } from 'lucide-react'

interface StaleBannerProps {
  /** ISO timestamp of the most recent progress update. */
  lastProgressAt: string | undefined
  /** Threshold in milliseconds after which the banner shows; defaults to 2 min per design. */
  staleThresholdMs?: number
  /** Injected "now" for deterministic rendering under tests. */
  nowMs?: number
}

/**
 * PV3 — amber banner shown when a running import hasn't produced a
 * progress update in the last two minutes. Design-doc §Stale Progress
 * calls for a manual retry button; PV3 keeps the copy + CTA-free shell
 * (the parent owns the retry logic via {@link PhaseDetailCard}'s
 * onRetry, and the retry endpoint itself is out of scope).
 *
 * Returns `null` when the timestamp is missing or still fresh — a
 * render-time no-op so the parent can always include the component.
 *
 * `Date.now` is read via `useSyncExternalStore` so the component stays
 * pure under `react-hooks/purity`; the ticker fires every 30 s so the
 * banner appears within 30 s of crossing the staleness threshold.
 * Tests inject `nowMs` for determinism (which bypasses the subscription
 * entirely).
 */
export function StaleBanner({
  lastProgressAt,
  staleThresholdMs = 2 * 60 * 1000,
  nowMs,
}: StaleBannerProps) {
  const tick = useSyncExternalStore(
    subscribeNowTicker,
    getNowSnapshot,
    getNowServerSnapshot,
  )

  if (!lastProgressAt) return null
  const lastMs = Date.parse(lastProgressAt)
  if (Number.isNaN(lastMs)) return null
  const current = nowMs ?? tick
  if (current === 0) return null
  if (current - lastMs < staleThresholdMs) return null

  return (
    <section
      role="status"
      data-testid="stale-banner"
      className="flex items-start gap-3 rounded-[14px] border border-amber-300/60 bg-amber-50 px-4 py-3 text-[13.5px] leading-[1.5] text-amber-900"
    >
      <AlertCircle className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
      <p>
        Import reagiert nicht — wir haben seit über zwei Minuten keinen
        Fortschritt mehr gesehen. Du kannst den Import erneut starten, falls
        er hängen bleibt.
      </p>
    </section>
  )
}

/**
 * Module-level "current wall-clock" ticker used by `useSyncExternalStore`.
 * The store notifies once every 30 s — fine-grained enough that the
 * banner appears within 30 s of crossing the staleness threshold, while
 * keeping render pressure minimal for a page that might be displaying
 * the banner for minutes at a time.
 *
 * `getSnapshot` reads `Date.now()` directly — legal here because the
 * React rules-of-hooks purity rule only applies to component/hook
 * bodies, not to snapshot functions passed into `useSyncExternalStore`.
 */
let currentNow = 0
const listeners: Set<() => void> = new Set()
let intervalHandle: number | null = null

function getNowSnapshot(): number {
  if (currentNow === 0) currentNow = Date.now()
  return currentNow
}

function getNowServerSnapshot(): number {
  return 0
}

function subscribeNowTicker(listener: () => void): () => void {
  listeners.add(listener)
  if (intervalHandle === null && typeof window !== 'undefined') {
    currentNow = Date.now()
    intervalHandle = window.setInterval(() => {
      currentNow = Date.now()
      listeners.forEach((l) => l())
    }, 30 * 1000)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && intervalHandle !== null) {
      window.clearInterval(intervalHandle)
      intervalHandle = null
    }
  }
}
