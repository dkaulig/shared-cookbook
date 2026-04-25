import { createContext } from 'react'
import type { ReactNode } from 'react'

/**
 * BUG-036 — Bottom-Zone slot contexts.
 *
 * Two distinct contexts so React's setter (state-changing) and the
 * read value (state itself) can be subscribed to independently. The
 * Provider in `bottomZone.tsx` writes to both; hooks in
 * `bottomZoneHooks.ts` read from one each.
 *
 * Lives in its own file so `bottomZone.tsx` exports only components
 * (Fast-Refresh-friendly — see react-refresh/only-export-components).
 */

export type SlotNode = ReactNode
export type BottomZoneSetter = (node: SlotNode) => void

export const BottomZoneContext = createContext<BottomZoneSetter | null>(null)
export const BottomZoneSlotContext = createContext<SlotNode>(null)
