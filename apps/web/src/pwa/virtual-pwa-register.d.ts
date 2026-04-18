/**
 * Module declaration for the virtual module exposed by vite-plugin-pwa.
 * The plugin provides its own types via `vite-plugin-pwa/client`, but
 * declaring the narrow subset we use here keeps the type surface small
 * and avoids needing the plugin types on the test host.
 */
declare module 'virtual:pwa-register' {
  export interface RegisterSWOptions {
    immediate?: boolean
    onNeedRefresh?: () => void
    onOfflineReady?: () => void
    onRegistered?: (registration: ServiceWorkerRegistration | undefined) => void
    onRegisterError?: (error: unknown) => void
  }

  export function registerSW(options?: RegisterSWOptions): (reloadPage?: boolean) => Promise<void>
}
