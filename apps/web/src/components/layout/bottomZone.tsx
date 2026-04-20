import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { PropsWithChildren, ReactNode } from 'react'

/**
 * BUG-036 — Unified Bottom-Zone slot.
 *
 * The BottomNav is the single source of truth for everything that lives
 * at the bottom of a mobile viewport. Pages that used to render their
 * own `fixed bottom-[…]` action bars (`RecipeActionBar`, `FormActionBar`,
 * GroupDetailPage FAB) push a contextual row into this slot via
 * `useBottomZoneSlot`.
 *
 *   - `<BottomZoneProvider>` wraps the authenticated app shell and owns
 *     the slot state.
 *   - `useBottomZoneSlot(node, deps)` sets the slot on mount / deps
 *     change and clears it on unmount. No exported setter — the hook is
 *     the single API.
 *
 * BUG-039 — the ResizeObserver that measured the rendered BottomNav
 * height into `--bottom-nav-height` is gone. Under the hoppr-style
 * flex-column layout, `<main>` is the scroll container and it already
 * stops at the BottomNav's top edge natively; no page needs to pad its
 * content to clear the nav anymore.
 */

type SlotNode = ReactNode
type BottomZoneSetter = (node: SlotNode) => void

const BottomZoneContext = createContext<BottomZoneSetter | null>(null)
const BottomZoneSlotContext = createContext<SlotNode>(null)

/**
 * Provides the slot state. The nav itself is rendered by the caller
 * (usually `<AppLayout>`) as a sibling of `children`, so this file
 * never imports `BottomNav.tsx` — keeping the hooks + context colocated
 * with the provider without introducing a circular module boundary.
 */
export function BottomZoneProvider({ children }: PropsWithChildren) {
  const [slot, setSlot] = useState<SlotNode>(null)

  const setSlotStable = useCallback<BottomZoneSetter>((node) => {
    setSlot(node)
  }, [])

  return (
    <BottomZoneContext.Provider value={setSlotStable}>
      <BottomZoneSlotContext.Provider value={slot}>
        {children}
      </BottomZoneSlotContext.Provider>
    </BottomZoneContext.Provider>
  )
}

/**
 * Page-side hook: renders `node` into the Bottom-Zone slot for the
 * lifetime of the calling component.
 *
 * `deps` flows through to the inner `useEffect` so callers can express
 * "re-mount the slot when these props change" exactly like any other
 * effect dependency. If the provider isn't in the tree (e.g. a
 * standalone test), the hook is a no-op.
 */
export function useBottomZoneSlot(
  node: SlotNode,
  deps: unknown[] = [],
): void {
  const set = useContext(BottomZoneContext)
  // `node` is (intentionally) not part of the dep array — the caller
  // controls the refresh cadence via `deps`. Capture the latest node
  // in a ref so the effect body still reads the newest JSX even if
  // deps don't change between renders. Write to the ref from an
  // effect to keep `react-hooks/refs` happy.
  const latest = useRef(node)
  useEffect(() => {
    latest.current = node
  })

  // Every dep change re-asserts the slot + installs a cleanup that
  // clears it on unmount. `set` is the useState setter from
  // BottomZoneProvider, stable across renders, so ESLint's "missing
  // dependency" warning is a false positive we intentionally suppress
  // alongside the `deps` spread.
  useEffect(
    () => {
      if (set == null) return
      set(latest.current)
      return () => set(null)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- caller-controlled effect key
    deps,
  )
}

/**
 * BottomNav-side hook: returns the current slot ReactNode and a
 * (legacy) ref callback. The ref was used by the BUG-036 ResizeObserver
 * that wrote `--bottom-nav-height`; BUG-039 removed the observer but we
 * keep the prop shape so BottomNav's JSX stays stable across the
 * refactor. The ref is a no-op function now.
 */
export function useBottomZoneConsumer(): {
  slot: SlotNode
  containerRef: (node: HTMLElement | null) => void
} {
  const slot = useContext(BottomZoneSlotContext)
  return { slot, containerRef: noopRef }
}

function noopRef(_node: HTMLElement | null): void {
  // no-op — see BUG-039 notes on useBottomZoneConsumer.
}
