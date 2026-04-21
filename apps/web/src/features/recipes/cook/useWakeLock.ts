import { useEffect, useRef, useState } from 'react'

/**
 * Minimal shape of the Screen Wake Lock API sentinel we rely on.
 *
 * We don't use the full DOM lib type so tests can inject a tiny fake
 * without pulling in the whole Web IDL surface.
 */
interface WakeLockSentinelLike {
  release: () => Promise<void>
}

interface WakeLockLike {
  request: (type: 'screen') => Promise<WakeLockSentinelLike>
}

/**
 * COOK-1 — screen wake-lock for the "Jetzt kochen" mode.
 *
 * Requests a `screen` wake-lock via the Screen Wake Lock API whenever
 * `active` is true; releases on deactivation / unmount. Re-acquires on
 * `document.visibilitychange` → 'visible' because iOS + Android release
 * the lock when the tab backgrounds and don't auto-restore it.
 *
 * Silently no-ops on browsers without `navigator.wakeLock` (returns
 * `supported: false`) and swallows `NotAllowedError` / user-rejection
 * so a denied prompt never crashes the cook flow.
 */
export function useWakeLock(active: boolean): { supported: boolean; granted: boolean } {
  const supported =
    typeof navigator !== 'undefined' &&
    typeof (navigator as unknown as { wakeLock?: WakeLockLike }).wakeLock !== 'undefined'
  const [granted, setGranted] = useState(false)
  const sentinelRef = useRef<WakeLockSentinelLike | null>(null)

  // COOK-reviewer follow-up — mirror `active` into a ref so the
  // visibilitychange handler always reads the freshest value. Without
  // this the handler closed over `active` from the effect scope: if
  // `active` flipped to false between renders before React's cleanup
  // detached the listener, a visibility → visible event still re-
  // requested the lock (stale-closure bug).
  const activeRef = useRef(active)
  useEffect(() => {
    activeRef.current = active
  }, [active])

  useEffect(() => {
    if (!supported || !active) return

    let cancelled = false

    async function acquire() {
      const wakeLock = (navigator as unknown as { wakeLock?: WakeLockLike }).wakeLock
      if (!wakeLock) return
      try {
        const sentinel = await wakeLock.request('screen')
        if (cancelled) {
          // Component unmounted / active flipped while awaiting — release
          // immediately so we never leak a lock.
          try {
            await sentinel.release()
          } catch {
            /* swallow — release race is harmless */
          }
          return
        }
        sentinelRef.current = sentinel
        setGranted(true)
      } catch {
        // NotAllowedError + other rejection paths: keep granted=false,
        // never surface the error to the cook flow.
        setGranted(false)
      }
    }

    function handleVisibilityChange() {
      if (document.visibilityState === 'visible' && activeRef.current) {
        void acquire()
      }
    }

    void acquire()
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      const sentinel = sentinelRef.current
      sentinelRef.current = null
      setGranted(false)
      if (sentinel) {
        void sentinel.release().catch(() => {
          /* swallow — double-release / already-released is fine */
        })
      }
    }
  }, [active, supported])

  return { supported, granted }
}
