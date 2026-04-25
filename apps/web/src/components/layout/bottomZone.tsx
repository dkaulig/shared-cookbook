import { useCallback, useState } from 'react'
import type { PropsWithChildren } from 'react'
import {
  BottomZoneContext,
  BottomZoneSlotContext,
  type BottomZoneSetter,
  type SlotNode,
} from './bottomZoneContext'

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
 *   - `useBottomZoneSlot(node, deps)` (in `bottomZoneHooks.ts`) sets
 *     the slot on mount / deps change and clears it on unmount.
 *
 * BUG-039 — the ResizeObserver that measured the rendered BottomNav
 * height into `--bottom-nav-height` is gone. Under the hoppr-style
 * flex-column layout, `<main>` is the scroll container and it already
 * stops at the BottomNav's top edge natively; no page needs to pad its
 * content to clear the nav anymore.
 *
 * POLISH-1 — context types + hooks were moved to sibling files
 * (`bottomZoneContext.ts`, `bottomZoneHooks.ts`) so this module
 * exports only the Provider component. Fast-Refresh's
 * `react-refresh/only-export-components` rule needs single-purpose
 * files; mixing the Provider with hooks/constants would defeat HMR.
 */

/**
 * Provides the slot state. The nav itself is rendered by the caller
 * (usually `<AppLayout>`) as a sibling of `children`, so this file
 * never imports `BottomNav.tsx` — keeping the Provider colocated with
 * its consumers without introducing a circular module boundary.
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
