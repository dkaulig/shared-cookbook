import { useEffect } from 'react'

/**
 * Shared helper: subscribe to `navigator.serviceWorker` `message`
 * events with a stable handler for the lifetime of the component. Both
 * {@link useBackgroundSyncMessage} and {@link useNetworkStatus} need
 * the same boilerplate — extracting it once keeps the two hooks
 * focused on what they do with the payload instead of how the plumbing
 * works.
 *
 * If the environment has no Service Worker API (jsdom + older Safari +
 * SSR) the hook is a silent no-op. Callers can depend on this being
 * safe to mount unconditionally.
 */
export function useSwMessage(handler: (event: MessageEvent) => void): void {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return
    }
    // Capture the container reference at mount-time. Tests that stub
    // `navigator.serviceWorker` and then uninstall before unmount would
    // otherwise NPE on the cleanup path.
    const container = navigator.serviceWorker
    container.addEventListener('message', handler)
    return () => {
      container.removeEventListener('message', handler)
    }
  }, [handler])
}
