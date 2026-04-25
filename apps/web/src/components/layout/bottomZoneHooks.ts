import { useContext, useEffect, useRef } from 'react'
import {
  BottomZoneContext,
  BottomZoneSlotContext,
  type SlotNode,
} from './bottomZoneContext'

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
  options: { disabled?: boolean } = {},
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

  // 2026-04-22 slot-conflict fix #2 — a `disabled` flag lets a
  // parent route defer the slot to its nested child. React fires
  // effects bottom-up, so if BOTH parent and child call
  // `useBottomZoneSlot`, the parent's `set()` runs AFTER the child's
  // and wins. Previously we tried "parent passes null when child is
  // mounted" — but that still overwrites the child's slot with null.
  // `disabled: true` skips the set-call entirely; the cleanup on the
  // parent's previous-effect (if any) still fires to release any
  // stale value. Net effect: parent effectively yields ownership to
  // the child when `disabled` is true.
  //
  // Every dep change re-asserts the slot + installs a cleanup that
  // clears it on unmount. `set` is the useState setter from
  // BottomZoneProvider, stable across renders, so ESLint's "missing
  // dependency" warning is a false positive we intentionally suppress
  // alongside the `deps` spread.
  const { disabled = false } = options
  useEffect(
    () => {
      if (set == null || disabled) return
      set(latest.current)
      return () => set(null)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- caller-controlled effect key
    [disabled, ...deps],
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
