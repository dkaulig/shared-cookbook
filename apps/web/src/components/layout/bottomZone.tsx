import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { PropsWithChildren, ReactNode } from 'react'

/**
 * BUG-036 — Unified Bottom-Zone slot.
 *
 * The BottomNav is the single source of truth for everything that lives
 * at the bottom of a mobile viewport. Pages that used to render their
 * own `fixed bottom-[calc(--bottom-nav-height…)]` action bars
 * (`RecipeActionBar`, `FormActionBar`, GroupDetailPage FAB) now push a
 * contextual row into this slot via `useBottomZoneSlot`.
 *
 *   - `<BottomZoneProvider>` wraps the authenticated app shell and owns
 *     the slot state + renders the `<BottomNav />` that consumes it.
 *   - `useBottomZoneSlot(node, deps)` sets the slot on mount / deps
 *     change and clears it on unmount. No exported setter — the hook is
 *     the single API.
 *
 * The Provider also measures the rendered height of the BottomNav
 * container via a ResizeObserver and writes it into
 * `--bottom-nav-height` on `:root`, so any consumer of that CSS token
 * (e.g. content-area `pb-[…]` padding, PwaUpdatePrompt) scales
 * automatically when a slot is mounted / unmounted.
 */

type SlotNode = ReactNode
type BottomZoneSetter = (node: SlotNode) => void

const BottomZoneContext = createContext<BottomZoneSetter | null>(null)
const BottomZoneSlotContext = createContext<SlotNode>(null)
const BottomZoneMeasureContext = createContext<
  ((node: HTMLElement | null) => void) | null
>(null)

/**
 * Provides the slot state + the measurement plumbing. The nav itself
 * is rendered by the caller (usually `<AppLayout>`) as a SIBLING of
 * `children`, so this file never imports `BottomNav.tsx` — keeping the
 * hooks + context colocated with the provider without introducing a
 * circular module boundary between provider and consumer.
 */
export function BottomZoneProvider({ children }: PropsWithChildren) {
  const [slot, setSlot] = useState<SlotNode>(null)
  // Keep the measurement effect keyed off the latest element handed to
  // us by BottomNav so we observe the right DOM node even if BottomNav
  // remounts (e.g. during hot reload).
  const [measuredEl, setMeasuredEl] = useState<HTMLElement | null>(null)

  const setSlotStable = useCallback<BottomZoneSetter>((node) => {
    setSlot(node)
  }, [])

  const registerMeasureTarget = useCallback(
    (node: HTMLElement | null) => setMeasuredEl(node),
    [],
  )

  // ResizeObserver → `--bottom-nav-height`. One source of truth: we
  // write the actual rendered outer-container height (safe-area pad +
  // slot-row + nav-row) back onto `:root` so any `calc(var(--bottom-nav-
  // height) + …)` consumer stays in sync without its own measurement.
  useEffect(() => {
    if (measuredEl == null) return
    if (typeof window === 'undefined') return
    const root = document.documentElement
    const DEFAULT = 'calc(env(safe-area-inset-bottom, 0px) + 56px)'

    if (typeof ResizeObserver === 'undefined') {
      // jsdom / very old browsers — leave the index.css default in place.
      root.style.setProperty('--bottom-nav-height', DEFAULT)
      return
    }

    const apply = () => {
      const h = measuredEl.getBoundingClientRect().height
      // Guard against a momentary 0 during the initial paint — fall back
      // to the CSS default so consumers don't collapse their padding.
      if (h > 0) {
        root.style.setProperty('--bottom-nav-height', `${Math.round(h)}px`)
      } else {
        root.style.setProperty('--bottom-nav-height', DEFAULT)
      }
    }

    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(measuredEl)
    return () => {
      ro.disconnect()
      // Reset to CSS default on unmount so stale JS-written values
      // don't shadow the stylesheet when the provider re-mounts.
      root.style.setProperty('--bottom-nav-height', DEFAULT)
    }
  }, [measuredEl])

  return (
    <BottomZoneContext.Provider value={setSlotStable}>
      <BottomZoneSlotContext.Provider value={slot}>
        <BottomZoneMeasureContext.Provider value={registerMeasureTarget}>
          {children}
        </BottomZoneMeasureContext.Provider>
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
 * BottomNav-side hook: returns the current slot ReactNode, and a
 * callback ref that the nav wires to its outer fixed container so the
 * Provider can measure its height.
 */
export function useBottomZoneConsumer(): {
  slot: SlotNode
  containerRef: (node: HTMLElement | null) => void
} {
  const slot = useContext(BottomZoneSlotContext)
  const registerMeasureTarget = useContext(BottomZoneMeasureContext)
  // `registerMeasureTarget` is stable (useCallback in provider) — memo
  // the wrapper so BottomNav's JSX doesn't re-attach the ref on every
  // render.
  const containerRef = useMemo(
    () => (node: HTMLElement | null) => {
      registerMeasureTarget?.(node)
    },
    [registerMeasureTarget],
  )
  return { slot, containerRef }
}
