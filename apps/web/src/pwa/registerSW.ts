/**
 * Thin wrapper around `registerSW` from the virtual
 * `virtual:pwa-register` module that vite-plugin-pwa injects at build
 * time. Exists so:
 *   - unit tests can mock a single, stable entry point, and
 *   - callers never import the virtual module directly.
 *
 * The plugin fetches + installs the service worker on first call;
 * subsequent calls are no-ops because registration is idempotent.
 */
import { registerSW } from 'virtual:pwa-register'

export interface PwaCallbacks {
  /** Fired when a new SW has downloaded and is waiting to take over. */
  onNeedRefresh?: () => void
  /** Fired once the first SW install completes and the app is offline-ready. */
  onOfflineReady?: () => void
}

/** Return type matches the plugin's `updateSW(reloadPage?: boolean) => Promise<void>`. */
export type UpdateSW = (reloadPage?: boolean) => Promise<void>

/**
 * Register the SW and wire external lifecycle callbacks. Returns the
 * update handler so callers can trigger a refresh once the new
 * version is ready.
 */
export function registerPwa(callbacks: PwaCallbacks): UpdateSW {
  return registerSW({
    immediate: true,
    onNeedRefresh: () => callbacks.onNeedRefresh?.(),
    onOfflineReady: () => callbacks.onOfflineReady?.(),
  })
}
