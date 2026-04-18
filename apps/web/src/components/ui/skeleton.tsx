import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

/**
 * shadcn-style Skeleton primitive. Renders a muted pulsing rectangle
 * used as a placeholder while async content loads. Apply size classes
 * (`h-4 w-32`, `h-36 w-full`, …) via the `className` prop.
 */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="status"
      aria-busy="true"
      className={cn('animate-pulse rounded-md bg-stone-200/80', className)}
      {...props}
    />
  )
}
