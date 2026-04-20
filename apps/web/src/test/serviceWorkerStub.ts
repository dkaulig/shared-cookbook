/**
 * Minimal stub of `navigator.serviceWorker` for tests that exercise
 * SW-message listeners. jsdom doesn't ship a ServiceWorkerContainer
 * implementation (as of v28 at least), so hooks under test that do
 * `navigator.serviceWorker.addEventListener('message', …)` need a
 * shim to fire events against.
 *
 * The stub records `message` listeners, and `dispatchSwMessage` calls
 * them synchronously with a MessageEvent. Listeners registered on the
 * stub across several renders share the same container — the
 * `uninstall` helper resets the list + removes the stub so tests
 * don't bleed into one another.
 */

type Listener = (event: MessageEvent) => void

interface SwStub {
  addEventListener: (type: string, listener: Listener) => void
  removeEventListener: (type: string, listener: Listener) => void
  __listeners: Set<Listener>
}

let installed = false
let previousDescriptor: PropertyDescriptor | undefined
let stub: SwStub | undefined

function createStub(): SwStub {
  const listeners = new Set<Listener>()
  return {
    __listeners: listeners,
    addEventListener(type: string, listener: Listener) {
      if (type !== 'message') return
      listeners.add(listener)
    },
    removeEventListener(type: string, listener: Listener) {
      if (type !== 'message') return
      listeners.delete(listener)
    },
  }
}

export function installServiceWorkerStub(): void {
  if (installed) return
  previousDescriptor = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker')
  stub = createStub()
  Object.defineProperty(navigator, 'serviceWorker', {
    value: stub,
    configurable: true,
    writable: true,
  })
  installed = true
}

export function uninstallServiceWorkerStub(): void {
  if (!installed) return
  if (previousDescriptor) {
    Object.defineProperty(navigator, 'serviceWorker', previousDescriptor)
  } else {
    // No prior descriptor — remove the property entirely.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (navigator as any).serviceWorker
  }
  stub = undefined
  previousDescriptor = undefined
  installed = false
}

export function dispatchSwMessage(data: unknown): void {
  if (!stub) throw new Error('installServiceWorkerStub() must be called first')
  const evt = new MessageEvent('message', { data })
  // Copy listeners so a listener that self-removes during dispatch
  // doesn't mutate the iteration.
  for (const listener of Array.from(stub.__listeners)) {
    listener(evt)
  }
}
