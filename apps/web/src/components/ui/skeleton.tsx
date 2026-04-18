import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

/**
 * shadcn-style Skeleton primitive. Renders a muted pulsing rectangle
 * used as a placeholder while async content loads. Apply size classes
 * (`h-4 w-32`, `h-36 w-full`, …) via the `className` prop.
 *
 * Uses the `bg-muted` token (DS7) so the placeholder automatically
 * picks up the Warme-Küche stone-100 cream-ish tint in light mode and
 * the stone-800 equivalent in `.dark`. Previously this was a hardcoded
 * `bg-stone-200/80` which read cold on the cream background.
 */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="status"
      aria-busy="true"
      className={cn('animate-pulse rounded-md bg-muted', className)}
      {...props}
    />
  )
}
